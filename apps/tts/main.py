"""OmniVoice + RVC TTS service (experiment).

Endpoints:
  GET  /engines       -> engine metadata (for the UI to build controls)
  POST /speak         -> multipart form, returns one audio/wav (chunked+merged)
  POST /speak-stream  -> multipart form, SSE stream of per-chunk audio + progress

The intentionally-small sibling of audio-processor-llm's TTS service: long-text
chunking, RVC post-processing, and progressive streaming — but none of the
speaker-library / history / auth surface.
"""

import base64
import io
import json
import os
import tempfile
from dataclasses import dataclass
from typing import AsyncGenerator, List, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse

from engines import engine_manager
from rvc import rvc_converter
from splitter import split_text

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
engine_manager.set_device(DEVICE)
rvc_converter.set_device(DEVICE)

app = FastAPI(title="OmniVoice + RVC TTS (experiment)")


@app.on_event("startup")
def _startup() -> None:
    print(f"[startup] device={DEVICE}, engines={engine_manager.available_engines}")
    if DEVICE == "cpu":
        print(
            "[startup] WARNING: no CUDA GPU detected. OmniVoice needs a GPU; "
            "generation will fail until this runs on a CUDA host."
        )


@app.get("/engines")
def engines() -> JSONResponse:
    return JSONResponse({"engines": engine_manager.get_engine_info()})


# ────────────────────────────────────────────────────────
# Request parsing + shared generation
# ────────────────────────────────────────────────────────
@dataclass
class SpeakRequest:
    text: str
    engine: str
    ref_text: Optional[str]
    instruct: Optional[str]
    params: dict
    use_rvc: bool
    rvc_model: str
    rvc_pitch: float
    ref_path: Optional[str]
    tmp_path: Optional[str]


async def _parse_request(
    text: str,
    engine: str,
    ref_text: str,
    instruct: str,
    temperature: float,
    top_p: float,
    cfg_scale: float,
    seed: int,
    use_rvc: bool,
    rvc_model: str,
    rvc_pitch: float,
    speaker_wav: Optional[UploadFile],
) -> SpeakRequest:
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    instruct = (instruct or "").strip()
    ref_text = (ref_text or "").strip()

    ref_path = tmp_path = None
    if speaker_wav is not None:
        suffix = os.path.splitext(speaker_wav.filename or "ref.wav")[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await speaker_wav.read())
            tmp_path = tmp.name
        ref_path = tmp_path

    if not ref_path and not instruct:
        raise HTTPException(
            status_code=400,
            detail="provide either a reference audio (cloning) or an instruct string (voice design)",
        )

    return SpeakRequest(
        text=text,
        engine=engine,
        ref_text=ref_text or None,
        instruct=instruct or None,
        params={
            "temperature": temperature,
            "top_p": top_p,
            "cfg_scale": cfg_scale,
            "seed": None if seed is None or seed < 0 else seed,
        },
        use_rvc=use_rvc,
        rvc_model=rvc_model,
        rvc_pitch=rvc_pitch,
        ref_path=ref_path,
        tmp_path=tmp_path,
    )


# OmniVoice (F5-style) sometimes prepends a short leaked syllable/word from the
# reference clip to the start of a cloned chunk (users hear a stray "for" before
# their text). It surfaces as: [short speech burst][pause][the real content].
# We detect that leading burst-then-pause and drop it. Toggle with STRIP_REF_LEAK.
_STRIP_LEAK = os.environ.get("STRIP_REF_LEAK", "1").lower() not in ("0", "false", "no", "")


def _strip_ref_leak(wav: np.ndarray, sr: int) -> np.ndarray:
    try:
        w = np.asarray(wav, dtype=np.float32).reshape(-1)
        fr = max(1, int(sr * 0.02))  # 20 ms frames
        n = len(w) // fr
        if n < 8:
            return wav
        # Framewise RMS energy.
        sq = w[: n * fr] ** 2
        e = np.sqrt(np.add.reduceat(sq, np.arange(0, n * fr, fr)) / fr)
        peak = float(e.max()) or 1e-6
        thr = peak * 0.12
        voiced = e >= thr

        # A leak begins at t≈0. If the clip starts with silence, there's no leak.
        if not voiced[:3].any():
            return wav

        i = 0
        while i < n and voiced[i]:
            i += 1
        burst_end = i
        gap_start = i
        while i < n and not voiced[i]:
            i += 1
        gap_end = i

        burst_dur = burst_end * 0.02
        gap_dur = (gap_end - gap_start) * 0.02

        # Leaked word = a SHORT leading burst, a real pause, then more content.
        if burst_dur <= 0.55 and 0.08 <= gap_dur <= 0.6 and gap_end < n:
            return w[gap_end * fr :]
        return wav
    except Exception:  # noqa: BLE001 — never fail generation over cleanup
        return wav


def _generate_chunk(req: SpeakRequest, chunk_text: str) -> tuple[np.ndarray, int]:
    eng = engine_manager.get_engine(req.engine)
    wav, sr = eng.generate(
        text=chunk_text,
        ref_audio_path=req.ref_path,
        ref_text=req.ref_text,
        instruct=req.instruct,
        params=req.params,
    )
    # Only cloning (ref-based) can leak the reference; skip for voice design.
    if req.ref_path and _STRIP_LEAK:
        wav = _strip_ref_leak(wav, sr)
    return wav, sr


def _maybe_rvc(req: SpeakRequest, wav: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    if req.use_rvc and req.rvc_model:
        return rvc_converter.convert(wav, sr, model=req.rvc_model, pitch_semitones=req.rvc_pitch)
    return wav, sr


def _to_wav_bytes(wav: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, wav, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ────────────────────────────────────────────────────────
# POST /speak — chunk long text, generate each, merge, one wav
# ────────────────────────────────────────────────────────
@app.post("/speak")
async def speak(
    text: str = Form(...),
    engine: str = Form(default="omnivoice"),
    ref_text: str = Form(default=""),
    instruct: str = Form(default=""),
    temperature: float = Form(default=0.7),
    top_p: float = Form(default=0.9),
    cfg_scale: float = Form(default=2.0),
    seed: int = Form(default=-1),
    use_rvc: bool = Form(default=False),
    rvc_model: str = Form(default=""),
    rvc_pitch: float = Form(default=0.0),
    speaker_wav: UploadFile | None = File(default=None),
):
    req = await _parse_request(
        text, engine, ref_text, instruct, temperature, top_p, cfg_scale, seed,
        use_rvc, rvc_model, rvc_pitch, speaker_wav,
    )
    try:
        chunks = split_text(req.text)
        pieces: List[np.ndarray] = []
        sr = 24000
        for ct in chunks:
            wav, sr = _generate_chunk(req, ct)
            pieces.append(wav)
            pieces.append(np.zeros(int(sr * 0.15), dtype=np.float32))  # gap between chunks

        merged = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
        merged, sr = _maybe_rvc(req, merged, sr)

        return Response(
            content=_to_wav_bytes(merged, sr),
            media_type="audio/wav",
            headers={
                "X-Sample-Rate": str(sr),
                "X-Engine": engine,
                "X-Chunks": str(len(chunks)),
                "X-RVC": "1" if (use_rvc and rvc_model) else "0",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"generation failed: {exc}")
    finally:
        if req.tmp_path and os.path.exists(req.tmp_path):
            os.unlink(req.tmp_path)


# ────────────────────────────────────────────────────────
# POST /speak-stream — SSE: progress + per-chunk wav for progressive playback
# ────────────────────────────────────────────────────────
def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


@app.post("/speak-stream")
async def speak_stream(
    text: str = Form(...),
    engine: str = Form(default="omnivoice"),
    ref_text: str = Form(default=""),
    instruct: str = Form(default=""),
    temperature: float = Form(default=0.7),
    top_p: float = Form(default=0.9),
    cfg_scale: float = Form(default=2.0),
    seed: int = Form(default=-1),
    use_rvc: bool = Form(default=False),
    rvc_model: str = Form(default=""),
    rvc_pitch: float = Form(default=0.0),
    speaker_wav: UploadFile | None = File(default=None),
):
    req = await _parse_request(
        text, engine, ref_text, instruct, temperature, top_p, cfg_scale, seed,
        use_rvc, rvc_model, rvc_pitch, speaker_wav,
    )

    async def stream() -> AsyncGenerator[str, None]:
        try:
            chunks = split_text(req.text)
            total = len(chunks)
            yield _sse({"type": "start", "total": total, "engine": engine})

            for i, ct in enumerate(chunks):
                try:
                    wav, sr = _generate_chunk(req, ct)
                    wav, sr = _maybe_rvc(req, wav, sr)
                    b64 = base64.b64encode(_to_wav_bytes(wav, sr)).decode("ascii")
                    yield _sse(
                        {
                            "type": "chunk",
                            "index": i,
                            "total": total,
                            "text": ct,
                            "sample_rate": sr,
                            "audio": b64,
                        }
                    )
                except Exception as exc:  # noqa: BLE001 — skip a bad chunk, keep going
                    yield _sse({"type": "chunk_error", "index": i, "detail": str(exc)})

            yield _sse({"type": "done", "total": total})
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            yield _sse({"type": "error", "detail": str(exc)})
        finally:
            if req.tmp_path and os.path.exists(req.tmp_path):
                os.unlink(req.tmp_path)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "9000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
