"""Pluggable source-separation engines."""

from __future__ import annotations

from .base import (
    CancellationToken,
    ModelInfo,
    SeparationEngine,
    SeparationRequest,
    SeparationResult,
)
from .demucs_engine import DEFAULT_MODEL_ID, DemucsEngine
from .registry import EngineRegistry
from .testing import FixtureEngine

__all__ = [
    "CancellationToken",
    "DEFAULT_MODEL_ID",
    "DemucsEngine",
    "EngineRegistry",
    "FixtureEngine",
    "ModelInfo",
    "SeparationEngine",
    "SeparationRequest",
    "SeparationResult",
]
