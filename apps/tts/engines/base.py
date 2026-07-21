"""Minimal TTS engine interface.

Kept deliberately small compared to audio-processor-llm's engine base — the goal
here is to *experience* OmniVoice, not to reproduce the full production surface.
The shape still mirrors production so a working engine can be lifted over later.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple

import numpy as np


class TTSEngine(ABC):
    """Common interface every TTS engine implements."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique engine id, e.g. 'omnivoice'."""
        ...

    @property
    @abstractmethod
    def display_name(self) -> str:
        ...

    @property
    @abstractmethod
    def sample_rate(self) -> int:
        ...

    @abstractmethod
    def load(self, device: str) -> None:
        """Load the model into VRAM/RAM."""
        ...

    @abstractmethod
    def is_loaded(self) -> bool:
        ...

    @abstractmethod
    def generate(
        self,
        text: str,
        ref_audio_path: Optional[str] = None,
        ref_text: Optional[str] = None,
        instruct: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Tuple[np.ndarray, int]:
        """Generate speech. Returns (waveform_1d_float32, sample_rate).

        Either supply ``ref_audio_path`` (voice cloning) or ``instruct``
        (voice design). If both are given the engine may use both.
        """
        ...

    def get_param_schema(self) -> Dict[str, Any]:
        """Parameter schema for the frontend to render controls from."""
        return {}

    def get_default_params(self) -> Dict[str, Any]:
        return {}
