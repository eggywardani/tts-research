"""RVC (Retrieval-based Voice Conversion) post-processing.

RVC runs *after* OmniVoice: OmniVoice generates speech, then RVC re-timbres that
audio toward a target voice defined by a trained `.pth` model (+ optional `.index`).

Uses `rvc-python` when installed and a model is present; otherwise falls back to a
pass-through so the rest of the stack keeps working (the toggle/model-path plumbing
stays exercised end-to-end). Install with `pip install rvc-python` and drop model
files into `RVC_MODELS_DIR` (default `models/rvc`).
"""

import os
import tempfile
from typing import Optional

import numpy as np
import soundfile as sf


class RVCConverter:
    def __init__(self, models_dir: str = "models/rvc") -> None:
        self.models_dir = models_dir
        self._rvc = None            # cached RVCInference instance
        self._loaded_model: Optional[str] = None
        self._device = "cuda:0"

    def set_device(self, device: str) -> None:
        # rvc-python wants "cuda:0" / "cpu:0" style.
        self._device = "cuda:0" if device.startswith("cuda") else "cpu:0"

    def available_models(self) -> list[str]:
        if not os.path.isdir(self.models_dir):
            return []
        return sorted(f for f in os.listdir(self.models_dir) if f.endswith(".pth"))

    def _ensure(self, model: str):
        """Load rvc-python lazily and (re)load the requested model. Returns the
        RVCInference instance, or None if the lib/model is unavailable."""
        model_path = os.path.join(self.models_dir, model)
        if not os.path.isfile(model_path):
            print(f"[RVC] model not found: {model_path} — skipping conversion.")
            return None

        try:
            if self._rvc is None:
                from rvc_python.infer import RVCInference

                self._rvc = RVCInference(device=self._device)
            if self._loaded_model != model:
                self._rvc.load_model(model_path)
                self._loaded_model = model
            return self._rvc
        except Exception as exc:  # noqa: BLE001
            print(f"[RVC] unavailable ({exc}) — skipping conversion.")
            return None

    def convert(
        self,
        wav: np.ndarray,
        sample_rate: int,
        model: str,
        pitch_semitones: float = 0.0,
        index_rate: float = 0.75,
    ) -> tuple[np.ndarray, int]:
        """Convert `wav` to the target voice `model`. Returns (wav, sample_rate).

        Falls back to pass-through if rvc-python or the model is unavailable.
        """
        rvc = self._ensure(model)
        if rvc is None:
            return wav, sample_rate

        in_path = out_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as fin:
                sf.write(fin.name, wav, sample_rate, subtype="PCM_16")
                in_path = fin.name
            out_path = in_path.replace(".wav", ".rvc.wav")

            # rvc-python knobs vary slightly by version; set what's supported.
            try:
                rvc.set_params(f0up_key=int(pitch_semitones), index_rate=index_rate)
            except Exception:  # noqa: BLE001
                pass

            rvc.infer_file(in_path, out_path)
            out_wav, out_sr = sf.read(out_path, dtype="float32")
            if out_wav.ndim > 1:
                out_wav = out_wav.mean(axis=1)
            return out_wav.astype(np.float32), int(out_sr)
        except Exception as exc:  # noqa: BLE001
            print(f"[RVC] inference failed ({exc}) — returning original audio.")
            return wav, sample_rate
        finally:
            for p in (in_path, out_path):
                if p and os.path.exists(p):
                    os.unlink(p)


rvc_converter = RVCConverter(models_dir=os.environ.get("RVC_MODELS_DIR", "models/rvc"))
