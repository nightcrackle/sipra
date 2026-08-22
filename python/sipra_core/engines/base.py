"""The separation engine contract.

Everything the app knows about source separation goes through this
interface. Demucs is the only implementation that ships today, but it is
an archived project — ``facebookresearch/demucs`` is read-only and the
author's fork takes critical fixes only — so the rest of Sipra is written
against this protocol rather than against Demucs directly. Swapping in a
Roformer or MDX engine later means adding one file here, not touching the
UI.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np

from ..errors import CancelledError

# stage name, 0.0-1.0 fraction
ProgressFn = Callable[[str, float], None]


@dataclass
class ModelInfo:
    """A model an engine can run."""

    id: str
    label: str
    stems: tuple[str, ...]
    description: str = ""
    experimental: bool = False
    # Rough multiple of real-time on a mid-range CPU. Used only to set
    # expectations in the UI, never for scheduling.
    relative_cost: float = 1.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "stems": list(self.stems),
            "description": self.description,
            "experimental": self.experimental,
            "relativeCost": self.relative_cost,
        }


@dataclass
class SeparationRequest:
    """Input to a separation run."""

    audio: np.ndarray  # float32, shape (channels, samples)
    sample_rate: int
    model_id: str
    stems: tuple[str, ...] | None = None  # None means "every stem the model has"
    device: str | None = None  # None means "let the engine choose"
    shifts: int = 0
    overlap: float = 0.25
    segment: float | None = None
    jobs: int = 0


@dataclass
class SeparationResult:
    """Output of a separation run."""

    stems: dict[str, np.ndarray]  # stem id -> (channels, samples) float32
    sample_rate: int
    model_id: str
    engine_id: str
    device: str
    warnings: list[str] = field(default_factory=list)


class CancellationToken:
    """A cooperative cancel flag shared with a running job.

    Engines poll this between chunks. It deliberately does not try to kill
    work mid-tensor — a torn PyTorch state is worse than waiting for the
    current segment to finish.
    """

    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self._event.is_set():
            raise CancelledError()


@runtime_checkable
class SeparationEngine(Protocol):
    """Contract every separation backend must satisfy."""

    id: str
    label: str

    def is_available(self) -> bool:
        """Whether this engine's dependencies are importable right now."""
        ...

    def unavailable_reason(self) -> str | None:
        """Human-readable explanation when :meth:`is_available` is False."""
        ...

    def models(self) -> list[ModelInfo]:
        """Models this engine can run."""
        ...

    def devices(self) -> list[str]:
        """Compute devices available, best first."""
        ...

    def separate(
        self,
        request: SeparationRequest,
        on_progress: ProgressFn | None = None,
        token: CancellationToken | None = None,
    ) -> SeparationResult:
        """Run separation. Must raise ``CancelledError`` if cancelled."""
        ...
