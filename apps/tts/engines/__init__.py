"""Engine registry. Single-engine for the experiment, but structured so more
engines (and load-on-demand swapping) can be added the way production does it.
"""

from typing import Dict, List, Optional, Type

from .base import TTSEngine
from .omnivoice import OmniVoiceEngine


class EngineManager:
    def __init__(self) -> None:
        self._registry: Dict[str, Type[TTSEngine]] = {}
        self._current: Optional[TTSEngine] = None
        self._current_name: str = ""
        self._device: str = "cpu"

    def set_device(self, device: str) -> None:
        self._device = device

    def register(self, name: str, cls: Type[TTSEngine]) -> None:
        self._registry[name] = cls

    @property
    def available_engines(self) -> List[str]:
        return list(self._registry.keys())

    def get_engine(self, name: str) -> TTSEngine:
        if name not in self._registry:
            raise ValueError(
                f"Unknown engine '{name}'. Available: {self.available_engines}"
            )
        if (
            self._current_name == name
            and self._current is not None
            and self._current.is_loaded()
        ):
            return self._current

        engine = self._registry[name]()
        engine.load(self._device)
        self._current = engine
        self._current_name = name
        return engine

    def get_engine_info(self) -> List[Dict]:
        info = []
        for name, cls in self._registry.items():
            inst = cls()
            info.append(
                {
                    "name": name,
                    "display_name": inst.display_name,
                    "sample_rate": inst.sample_rate,
                    "default_params": inst.get_default_params(),
                    "param_schema": inst.get_param_schema(),
                    "is_active": name == self._current_name,
                }
            )
        return info


engine_manager = EngineManager()
engine_manager.register("omnivoice", OmniVoiceEngine)
