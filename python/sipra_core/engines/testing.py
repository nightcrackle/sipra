"""A fixture engine for development and tests.

This is **not** a source separator. It splits the input into frequency
bands and labels them with stem names so the rest of the pipeline — job
queue, progress events, peak generation, the whole waveform workspace —
can be exercised without a 2 GB PyTorch install.

It is registered only when ``SIPRA_ENABLE_FIXTURE_ENGINE=1`` and the UI
labels it explicitly, so nobody can mistake its output for real stems.
"""

from __future__ import annotations

import numpy as np

from ..errors import ErrorCode, SipraError
from ..stems import FOUR_STEM_SET, SIX_STEM_SET
from .base import (
    CancellationToken,
    ModelInfo,
    ProgressFn,
    SeparationRequest,
    SeparationResult,
)

ENGINE_ID = "fixture"

MODELS: tuple[ModelInfo, ...] = (
    ModelInfo(
        id="fixture-4",
        label="Fixture band split (4 stems) — not a real separator",
        stems=FOUR_STEM_SET,
        description="Development only. Splits by frequency band, separates nothing.",
        experimental=True,
        relative_cost=0.01,
    ),
    ModelInfo(
        id="fixture-6",
        label="Fixture band split (6 stems) — not a real separator",
        stems=SIX_STEM_SET,
        description="Development only. Splits by frequency band, separates nothing.",
        experimental=True,
        relative_cost=0.01,
    ),
)

MODELS_BY_ID = {m.id: m for m in MODELS}

# Crossover points in Hz, ordered low to high. n stems need n-1 crossovers.
_CROSSOVERS: dict[int, tuple[float, ...]] = {
    4: (200.0, 1200.0, 5000.0),
    6: (120.0, 500.0, 1500.0, 4000.0, 9000.0),
}


class FixtureEngine:
    """Deterministic stand-in for a real separation engine."""

    id = ENGINE_ID
    label = "Fixture (development only)"

    def is_available(self) -> bool:
        return True

    def unavailable_reason(self) -> str | None:
        return None

    def models(self) -> list[ModelInfo]:
        return list(MODELS)

    def devices(self) -> list[str]:
        return ["cpu"]

    def describe_device(self, device: str) -> str:
        return "CPU"

    def prepare_model(
        self,
        model_id: str,
        device: str | None = None,
        warmup: bool = True,
        on_progress: ProgressFn | None = None,
    ) -> dict:
        """Nothing to fetch, but the same shape and the same reports.

        The fixture engine stands in for a real one in the tests that cover
        first-run preparation, so it has to answer the same question.
        """
        if model_id not in MODELS_BY_ID:
            raise SipraError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Unknown fixture model '{model_id}'",
                {"available": list(MODELS_BY_ID)},
            )
        if on_progress:
            on_progress("model", 0.05)
            on_progress("model", 1.0)
        return {
            "prepared": True,
            "engine": self.id,
            "model": model_id,
            "device": device or "cpu",
            "downloaded": False,
            "warmed": bool(warmup),
            "seconds": 0.0,
        }

    def separate(
        self,
        request: SeparationRequest,
        on_progress: ProgressFn | None = None,
        token: CancellationToken | None = None,
    ) -> SeparationResult:
        model = MODELS_BY_ID.get(request.model_id)
        if model is None:
            raise SipraError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Unknown fixture model '{request.model_id}'",
                {"available": list(MODELS_BY_ID)},
            )

        audio = np.asarray(request.audio, dtype=np.float32)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        if audio.shape[1] == 0:
            raise SipraError(ErrorCode.SEPARATION_FAILED, "Input audio is empty")

        wanted = tuple(request.stems) if request.stems else model.stems
        crossovers = _CROSSOVERS[len(model.stems)]
        bands = _split_bands(audio, request.sample_rate, crossovers)

        out: dict[str, np.ndarray] = {}
        total = len(model.stems)
        for index, stem_id in enumerate(model.stems):
            if token is not None:
                token.raise_if_cancelled()
            if stem_id in wanted:
                out[stem_id] = bands[index]
            if on_progress:
                on_progress("separate", (index + 1) / total)

        return SeparationResult(
            stems=out,
            sample_rate=request.sample_rate,
            model_id=model.id,
            engine_id=self.id,
            device="cpu",
            warnings=[
                "Fixture engine: these are frequency bands, not separated sources."
            ],
        )


def _split_bands(
    audio: np.ndarray, sample_rate: int, crossovers: tuple[float, ...]
) -> list[np.ndarray]:
    """Split into complementary bands that sum back to the original.

    Each band is ``lowpass(hi) - lowpass(lo)``, so summing every band
    reconstructs the input exactly. That property is what makes this
    useful as a pipeline fixture: the mix-down maths downstream can be
    verified against a known-exact reconstruction.
    """
    from scipy.signal import butter, sosfiltfilt

    nyquist = sample_rate / 2.0
    cumulative: list[np.ndarray] = []
    for cutoff in crossovers:
        normalised = min(max(cutoff / nyquist, 1e-4), 0.999)
        sos = butter(4, normalised, btype="low", output="sos")
        cumulative.append(sosfiltfilt(sos, audio, axis=1).astype(np.float32))

    bands: list[np.ndarray] = []
    previous = np.zeros_like(audio)
    for low_passed in cumulative:
        bands.append((low_passed - previous).astype(np.float32))
        previous = low_passed
    bands.append((audio - previous).astype(np.float32))
    return bands
