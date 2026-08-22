"""Engine registry.

Holds one instance of each known engine and answers "what can this
machine actually do right now" for the capabilities handshake the UI
performs on startup.
"""

from __future__ import annotations

import os

from ..errors import ErrorCode, SipraError
from .base import SeparationEngine
from .demucs_engine import DEFAULT_MODEL_ID, DemucsEngine
from .testing import FixtureEngine

FIXTURE_ENV_FLAG = "SIPRA_ENABLE_FIXTURE_ENGINE"


class EngineRegistry:
    """Lookup for the separation engines this build knows about."""

    def __init__(self, engines: list[SeparationEngine] | None = None) -> None:
        if engines is None:
            engines = [DemucsEngine()]
            if os.environ.get(FIXTURE_ENV_FLAG) == "1":
                engines.append(FixtureEngine())
        self._engines: dict[str, SeparationEngine] = {e.id: e for e in engines}

    def all(self) -> list[SeparationEngine]:
        return list(self._engines.values())

    def get(self, engine_id: str) -> SeparationEngine:
        engine = self._engines.get(engine_id)
        if engine is None:
            raise SipraError(
                ErrorCode.ENGINE_UNAVAILABLE,
                f"Unknown engine '{engine_id}'",
                {"available": list(self._engines)},
            )
        return engine

    def available(self) -> list[SeparationEngine]:
        return [e for e in self._engines.values() if e.is_available()]

    def default_engine(self) -> SeparationEngine:
        """First available engine, preferring Demucs.

        Raises when nothing is usable rather than silently falling back to
        the fixture engine — handing someone frequency bands and calling
        them stems would be worse than a clear error.
        """
        for engine_id in ("demucs",):
            engine = self._engines.get(engine_id)
            if engine is not None and engine.is_available():
                return engine
        usable = self.available()
        if usable:
            return usable[0]
        raise SipraError(
            ErrorCode.ENGINE_UNAVAILABLE,
            "No separation engine is available. Sipra's audio runtime may not have "
            "finished installing.",
            {
                "engines": {
                    e.id: e.unavailable_reason() for e in self._engines.values()
                }
            },
        )

    def resolve(
        self, engine_id: str | None, model_id: str | None
    ) -> tuple[SeparationEngine, str]:
        """Pick an (engine, model) pair, validating that they belong together."""
        engine = self.get(engine_id) if engine_id else self.default_engine()
        if not engine.is_available():
            raise SipraError(
                ErrorCode.ENGINE_UNAVAILABLE,
                engine.unavailable_reason() or f"Engine '{engine.id}' is unavailable",
                {"engine": engine.id},
            )

        model_ids = [m.id for m in engine.models()]
        if model_id is None:
            chosen = DEFAULT_MODEL_ID if DEFAULT_MODEL_ID in model_ids else model_ids[0]
            return engine, chosen
        if model_id not in model_ids:
            raise SipraError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Engine '{engine.id}' has no model '{model_id}'",
                {"available": model_ids},
            )
        return engine, model_id

    def capabilities(self) -> dict:
        """Everything the UI needs to populate its engine and model pickers."""
        payload = []
        for engine in self._engines.values():
            available = engine.is_available()
            payload.append(
                {
                    "id": engine.id,
                    "label": engine.label,
                    "available": available,
                    "unavailableReason": None if available else engine.unavailable_reason(),
                    "devices": engine.devices() if available else [],
                    "models": [m.to_dict() for m in engine.models()],
                }
            )
        return {"engines": payload}
