# TTS service — OmniVoice + RVC

FastAPI service. Needs a **CUDA GPU** for OmniVoice.

## Run

```bash
cd apps/tts
python -m venv .venv && source .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cu121   # match your CUDA
pip install -r requirements.txt
PORT=9000 python main.py
```

On a Mac (no CUDA) the service still boots and `/health` works, but `/speak`
returns 500 because the model can't load. Deploy the service on a GPU host and
point the backend API at it via `TTS_URL`.

## Endpoints

| Method | Path            | Notes                                                    |
| ------ | --------------- | -------------------------------------------------------- |
| GET    | `/health`       | device + available engines + RVC models                  |
| GET    | `/engines`      | engine metadata + param schema (drives the UI)           |
| POST   | `/speak`        | multipart form → one merged `audio/wav`                  |
| POST   | `/speak-stream` | multipart form → SSE (`start`/`chunk`/`done`) for preview |

Shared fields: `text` (required), `engine`, `ref_text`, `instruct`,
`temperature`, `top_p`, `cfg_scale`, `seed`, `use_rvc`, `rvc_model`,
`rvc_pitch`, and `speaker_wav` (file). Provide **either** a `speaker_wav`
(voice cloning) **or** an `instruct` string (voice design). Long text is split
into sentence-aware chunks (`splitter.py`); `/speak` merges them, `/speak-stream`
emits each as a base64 wav as it renders.

## RVC

Drop trained models into `RVC_MODELS_DIR` (default `models/rvc`) as `.pth`
(+ optional `.index`) and `pip install rvc-python`. Without the lib or a matching
model, `rvc/converter.py` falls back to pass-through so nothing breaks.

## Layout

- `engines/base.py` — engine interface
- `engines/omnivoice.py` — the OmniVoice engine (only file touching the model)
- `splitter.py` — sentence-aware long-text chunking
- `rvc/converter.py` — RVC post-processing (`rvc-python`, pass-through fallback)
