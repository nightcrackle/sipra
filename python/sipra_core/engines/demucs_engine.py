"""Demucs separation engine.

Wraps ``demucs.api``. Two things are worth knowing about this backend:

* **It is archived upstream.** Meta's repository is read-only and the
  original author's fork only accepts critical fixes. Version pins in
  ``requirements`` matter more here than usual.
* **The 6-stem model is uneven.** ``htdemucs_6s`` is the only widely
  available local model that emits guitar and piano, and Demucs' own
  README describes the piano source as "not working great" with "a lot of
  bleeding and artifacts". Sipra therefore defaults to the 4-stem model
  and flags the extra two sources as experimental in the UI rather than
  quietly shipping a bad piano stem.

Audio is handed to Demucs as an in-memory tensor rather than a file path,
so formats libsndfile cannot open (M4A, WMA) still work — we have already
decoded them via ffmpeg by this point.
"""

from __future__ import annotations

import io
from contextlib import redirect_stdout
from typing import Any

import numpy as np

from ..errors import CancelledError, ErrorCode, SipraError
from ..stems import FOUR_STEM_SET, SIX_STEM_SET
from ..trace import Throttle, trace
from .base import (
    CancellationToken,
    ModelInfo,
    ProgressFn,
    SeparationRequest,
    SeparationResult,
)

ENGINE_ID = "demucs"

# Demucs' internal source names map onto our canonical stem ids 1:1 today,
# but keeping the mapping explicit means a future model with different
# naming does not silently produce stems the UI cannot render.
DEMUCS_SOURCE_TO_STEM: dict[str, str] = {
    "vocals": "vocals",
    "drums": "drums",
    "bass": "bass",
    "guitar": "guitar",
    "piano": "piano",
    "other": "other",
}

MODELS: tuple[ModelInfo, ...] = (
    ModelInfo(
        id="htdemucs",
        label="Hybrid Transformer (4 stems)",
        stems=FOUR_STEM_SET,
        description="The default. Cleanest results and the fastest of the good models.",
        relative_cost=1.0,
    ),
    ModelInfo(
        id="htdemucs_ft",
        label="Hybrid Transformer, fine-tuned (4 stems)",
        stems=FOUR_STEM_SET,
        description="Noticeably better separation, roughly four times slower.",
        relative_cost=4.0,
    ),
    ModelInfo(
        id="htdemucs_6s",
        label="Hybrid Transformer (6 stems)",
        stems=SIX_STEM_SET,
        description=(
            "Adds guitar and piano. Guitar is usable; piano bleeds badly and is "
            "best treated as a rough guide rather than a finished stem."
        ),
        experimental=True,
        relative_cost=1.2,
    ),
    ModelInfo(
        id="mdx_extra",
        label="MDX Extra (4 stems)",
        stems=FOUR_STEM_SET,
        description="Alternative model; sometimes better on bass-heavy material.",
        relative_cost=1.3,
    ),
)

MODELS_BY_ID: dict[str, ModelInfo] = {m.id: m for m in MODELS}

DEFAULT_MODEL_ID = "htdemucs"
DEMUCS_SAMPLE_RATE = 44100


class DemucsEngine:
    """Separation backed by ``demucs.api``."""

    id = ENGINE_ID
    label = "Demucs"

    def __init__(self) -> None:
        self._availability: tuple[bool, str | None] | None = None

    # -- availability ---------------------------------------------------

    def _check(self) -> tuple[bool, str | None]:
        if self._availability is not None:
            return self._availability
        try:
            import torch  # noqa: F401
        except ImportError as exc:
            self._availability = (False, f"PyTorch is not installed ({exc})")
            return self._availability
        try:
            import demucs.api  # noqa: F401
        except ImportError as exc:
            self._availability = (False, f"Demucs is not installed ({exc})")
            return self._availability
        self._availability = (True, None)
        return self._availability

    def is_available(self) -> bool:
        return self._check()[0]

    def unavailable_reason(self) -> str | None:
        return self._check()[1]

    def models(self) -> list[ModelInfo]:
        return list(MODELS)

    def devices(self) -> list[str]:
        """Compute devices, best first. CPU is always last and always present."""
        found: list[str] = []
        try:
            import torch

            if torch.cuda.is_available():
                found.append("cuda")
            # Apple Silicon is not a Sipra target today, but detecting it
            # costs nothing and keeps the engine honest if that changes.
            if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                found.append("mps")
        except Exception:
            pass
        found.append("cpu")
        return found

    def describe_device(self, device: str) -> str:
        if device != "cuda":
            return device.upper()
        try:
            import torch

            return f"CUDA ({torch.cuda.get_device_name(0)})"
        except Exception:  # pragma: no cover
            return "CUDA"

    # -- separation -----------------------------------------------------

    def separate(
        self,
        request: SeparationRequest,
        on_progress: ProgressFn | None = None,
        token: CancellationToken | None = None,
    ) -> SeparationResult:
        available, reason = self._check()
        if not available:
            raise SipraError(
                ErrorCode.ENGINE_UNAVAILABLE,
                reason or "Demucs is not available",
                {"engine": self.id},
            )

        model_id = request.model_id or DEFAULT_MODEL_ID
        if model_id not in MODELS_BY_ID:
            raise SipraError(
                ErrorCode.MODEL_UNAVAILABLE,
                f"Unknown Demucs model '{model_id}'",
                {"available": [m.id for m in MODELS]},
            )
        model_info = MODELS_BY_ID[model_id]

        device = request.device or self.devices()[0]
        warnings: list[str] = []

        import demucs.api
        import torch

        audio = np.asarray(request.audio, dtype=np.float32)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        if audio.shape[1] == 0:
            raise SipraError(ErrorCode.SEPARATION_FAILED, "Input audio is empty")

        # Demucs is trained on stereo. Mono input is duplicated rather than
        # left as one channel, which the model handles poorly.
        if audio.shape[0] == 1:
            audio = np.repeat(audio, 2, axis=0)
        elif audio.shape[0] > 2:
            warnings.append(
                f"Input had {audio.shape[0]} channels; folded down to stereo for separation."
            )
            audio = np.stack([audio[0], audio[1]])

        reporter = _ProgressReporter(on_progress, token)

        # Demucs and torch.hub both write to stdout. Stdout is the protocol
        # channel, so anything they emit is diverted to stderr.
        noise = io.StringIO()
        try:
            with redirect_stdout(noise):
                # Constructing the Separator is where model weights are
                # fetched the first time a model is used — up to a few
                # hundred megabytes, with its progress bar swallowed by the
                # redirect above. Without this line that download is a
                # silent multi-minute pause at the start of separation.
                trace("loading the model", model=model_id, device=device)
                separator = demucs.api.Separator(
                    model=model_id,
                    device=device,
                    shifts=max(0, int(request.shifts)),
                    overlap=float(np.clip(request.overlap, 0.0, 0.95)),
                    split=True,
                    segment=request.segment,
                    jobs=max(0, int(request.jobs)),
                    progress=False,
                    callback=reporter.callback,
                )
                trace("model ready")
                wav = torch.from_numpy(np.ascontiguousarray(audio))
                _origin, separated = separator.separate_tensor(
                    wav, sr=int(request.sample_rate)
                )
                trace("model run finished", segments=reporter.calls)
                model_sample_rate = int(getattr(separator, "samplerate", DEMUCS_SAMPLE_RATE))
        except CancelledError:
            raise
        except SipraError:
            raise
        except (RuntimeError, OSError) as exc:
            raise SipraError(
                ErrorCode.SEPARATION_FAILED,
                _friendly_failure(exc, device),
                {"model": model_id, "device": device, "detail": str(exc)[:500]},
            ) from exc
        except Exception as exc:  # pragma: no cover - unexpected upstream failure
            raise SipraError(
                ErrorCode.SEPARATION_FAILED,
                f"Demucs failed while separating: {exc}",
                {"model": model_id, "device": device},
            ) from exc
        finally:
            leaked = noise.getvalue().strip()
            if leaked:
                import sys

                print(leaked, file=sys.stderr)

        if token is not None:
            token.raise_if_cancelled()

        wanted = set(request.stems) if request.stems else None
        out: dict[str, np.ndarray] = {}

        # Moving each source off the compute device is real work — on CUDA
        # it is a device-to-host copy of tens of megabytes per stem — and
        # it used to happen with the bar frozen on the last separation
        # update. It reports as its own stage now.
        names = list(separated.keys())
        for index, source_name in enumerate(names):
            tensor = separated[source_name]
            stem_id = DEMUCS_SOURCE_TO_STEM.get(source_name, source_name)
            if wanted is None or stem_id in wanted:
                trace("collecting", stem=stem_id)
                out[stem_id] = tensor.detach().cpu().numpy().astype(np.float32, copy=False)
            if on_progress:
                on_progress("collect", (index + 1) / max(1, len(names)))

        if not out:
            raise SipraError(
                ErrorCode.SEPARATION_FAILED,
                "Separation produced no stems",
                {"model": model_id, "requested": list(request.stems or ())},
            )

        missing = sorted(set(model_info.stems) - set(out)) if wanted is None else []
        if missing:
            warnings.append(f"Model did not return: {', '.join(missing)}")

        if on_progress:
            on_progress("separate", 1.0)

        return SeparationResult(
            stems=out,
            sample_rate=model_sample_rate,
            model_id=model_id,
            engine_id=self.id,
            device=device,
            warnings=warnings,
        )


class _ProgressReporter:
    """Turns Demucs' segment callbacks into a monotonic 0-1 fraction.

    Demucs reports ``segment_offset`` in samples per model in the bag, and
    a bag can hold several models (``htdemucs_ft`` holds four). Progress is
    therefore scaled within each model's slice of the total, and clamped so
    it can never move backwards — a progress bar that jumps back reads as a
    bug even when the underlying work is fine.
    """

    def __init__(self, on_progress: ProgressFn | None, token: CancellationToken | None):
        self._on_progress = on_progress
        self._token = token
        self._last = 0.0
        self._throttle = Throttle(5.0)
        #: How many times Demucs has called back. A separation that appears
        #: frozen but whose count is still climbing is working, not stuck.
        self.calls = 0

    def callback(self, payload: dict[str, Any]) -> None:
        if self._token is not None and self._token.cancelled:
            # demucs.api treats a raised exception as an abort signal.
            raise CancelledError()
        self.calls += 1
        try:
            models = max(1, int(payload.get("models", 1) or 1))
            index = int(payload.get("model_idx_in_bag", 0) or 0)
            length = float(payload.get("audio_length", 0) or 0)
            offset = float(payload.get("segment_offset", 0) or 0)
            within = (offset / length) if length > 0 else 0.0
            fraction = (index + min(max(within, 0.0), 1.0)) / models
        except Exception:  # pragma: no cover - never let progress break a job
            return

        # The heartbeat. The bar stops at the last segment of the last
        # model while the model is still running it, so "the bar is not
        # moving" and "nothing is happening" look identical from outside.
        # These lines separate them: if they keep arriving, it is working.
        if self._throttle.ready():
            trace(
                "separating",
                model=f"{index + 1}/{models}",
                at=f"{fraction * 100:.1f}%",
                calls=self.calls,
            )

        if self._on_progress is None:
            return
        fraction = min(max(fraction, 0.0), 0.999)
        if fraction > self._last:
            self._last = fraction
            self._on_progress("separate", fraction)


def _friendly_failure(exc: Exception, device: str) -> str:
    """Translate the two failures users actually hit into plain language."""
    text = str(exc).lower()
    if "out of memory" in text:
        if device == "cuda":
            return (
                "Your GPU ran out of memory. Try the 4-stem model, or switch to "
                "CPU in Settings."
            )
        return "Ran out of memory. Try a shorter section or close other applications."
    if "no such file" in text or "not found" in text or "connection" in text:
        return (
            "The model weights could not be downloaded. Sipra needs internet access "
            "the first time each model is used; after that it works offline."
        )
    return f"Demucs failed while separating: {exc}"
