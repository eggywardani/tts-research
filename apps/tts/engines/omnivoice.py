"""OmniVoice engine — zero-shot multilingual TTS with voice cloning + voice design.

Model: k2-fsa/OmniVoice (https://github.com/k2-fsa/OmniVoice)
- 600+ languages, 24 kHz mono output
- Voice cloning from a 3-10s reference clip (ref_text optional; Whisper auto-ASR)
- Voice design via `instruct` attributes: "female, low pitch, british accent"

Requires a CUDA GPU. The API surface below follows the documented usage; if the
installed package differs slightly, adjust `generate()` — it is the only place
that touches the model.
"""

from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .base import TTSEngine

OMNIVOICE_SR = 24000


class OmniVoiceEngine(TTSEngine):
    def __init__(self) -> None:
        self._model = None
        self._device = "cpu"

    @property
    def name(self) -> str:
        return "omnivoice"

    @property
    def display_name(self) -> str:
        return "OmniVoice (zero-shot multilingual)"

    @property
    def sample_rate(self) -> int:
        return OMNIVOICE_SR

    def load(self, device: str) -> None:
        if self._model is not None:
            return
        import torch
        from omnivoice import OmniVoice

        self._device = device
        dtype = torch.float16 if device.startswith("cuda") else torch.float32
        print(f"[OmniVoice] loading model on {device} ({dtype})...")
        self._model = OmniVoice.from_pretrained(
            "k2-fsa/OmniVoice",
            device_map=device,
            dtype=dtype,
        )
        print("[OmniVoice] model ready.")

    def is_loaded(self) -> bool:
        return self._model is not None

    def generate(
        self,
        text: str,
        ref_audio_path: Optional[str] = None,
        ref_text: Optional[str] = None,
        instruct: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Tuple[np.ndarray, int]:
        if self._model is None:
            raise RuntimeError("OmniVoice model not loaded — call load() first.")

        params = params or {}
        kwargs: Dict[str, Any] = {"text": text}

        if ref_audio_path:
            kwargs["ref_audio"] = ref_audio_path
            if ref_text:
                kwargs["ref_text"] = ref_text
        if instruct:
            kwargs["instruct"] = instruct

        # Optional sampling knobs, forwarded only if provided.
        for key in ("temperature", "top_p", "seed", "cfg_scale"):
            if key in params and params[key] is not None:
                kwargs[key] = params[key]

        audio = self._model.generate(**kwargs)

        # generate() returns a list of np.ndarray (T,) at 24 kHz; take the first.
        wav = audio[0] if isinstance(audio, (list, tuple)) else audio
        wav = np.asarray(wav, dtype=np.float32).reshape(-1)
        return wav, OMNIVOICE_SR

    def get_default_params(self) -> Dict[str, Any]:
        return {"temperature": 0.7, "top_p": 0.9, "cfg_scale": 2.0, "seed": -1}

    def get_param_schema(self) -> Dict[str, Any]:
        return {
            "temperature": {"type": "float", "min": 0.1, "max": 1.5, "step": 0.05, "default": 0.7},
            "top_p": {"type": "float", "min": 0.1, "max": 1.0, "step": 0.05, "default": 0.9},
            "cfg_scale": {"type": "float", "min": 1.0, "max": 5.0, "step": 0.1, "default": 2.0},
            "seed": {"type": "int", "min": -1, "max": 2**31 - 1, "default": -1},
        }
