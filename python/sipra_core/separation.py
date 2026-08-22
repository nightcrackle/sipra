"""The separation pipeline.

Ties together decode, separation, stem writing, peak generation and
analysis, and reports a single monotonic progress fraction across all of
them so the UI can show one honest bar instead of five that each restart
at zero.

Everything is written under a per-track directory::

    <outputDir>/
        source.wav              copy of the input, normalised to WAV
        stems/<stem>.wav        one file per separated stem
        peaks/<name>.speaks     min/max envelopes for the waveform lanes
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .analysis import analyse_buffer
from .audio_io import AudioBuffer, load_audio, write_audio
from .engines.base import CancellationToken, SeparationRequest
from .engines.registry import EngineRegistry
from .errors import ErrorCode, SipraError
from .stems import sort_stems
from .waveform import DEFAULT_SAMPLES_PER_BUCKET, compute_peaks, write_peaks

ProgressFn = Callable[[str, float], None]

# Fraction of the overall job each stage is worth. Separation dominates by
# so much that everything else is rounding error, but a bar that sits at
# 100% for ten seconds while peaks are written feels broken, so the tail
# stages get a visible slice.
STAGE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("decode", 0.06),
    ("separate", 0.74),
    ("write", 0.08),
    ("peaks", 0.06),
    ("analyse", 0.06),
)

DEFAULT_STEM_SUBTYPE = "PCM_16"


@dataclass
class StemArtifact:
    stem_id: str
    audio_path: Path
    peaks_path: Path
    sample_peak_db: float
    rms_db: float

    def to_dict(self) -> dict:
        return {
            "id": self.stem_id,
            "audioPath": str(self.audio_path),
            "peaksPath": str(self.peaks_path),
            "samplePeakDb": _finite(self.sample_peak_db),
            "rmsDb": _finite(self.rms_db),
        }


@dataclass
class SeparationOutcome:
    track_dir: Path
    source_path: Path
    source_peaks_path: Path
    sample_rate: int
    duration_seconds: float
    channels: int
    engine_id: str
    model_id: str
    device: str
    stems: list[StemArtifact] = field(default_factory=list)
    analysis: dict | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "trackDir": str(self.track_dir),
            "sourcePath": str(self.source_path),
            "sourcePeaksPath": str(self.source_peaks_path),
            "sampleRate": self.sample_rate,
            "durationSeconds": round(self.duration_seconds, 4),
            "channels": self.channels,
            "engineId": self.engine_id,
            "modelId": self.model_id,
            "device": self.device,
            "stems": [s.to_dict() for s in self.stems],
            "analysis": self.analysis,
            "warnings": list(self.warnings),
        }


class _StageProgress:
    """Maps per-stage 0-1 fractions onto one monotonic overall fraction."""

    def __init__(self, on_progress: ProgressFn | None) -> None:
        self._on_progress = on_progress
        self._offsets: dict[str, tuple[float, float]] = {}
        self._high_water = 0.0
        cursor = 0.0
        for name, weight in STAGE_WEIGHTS:
            self._offsets[name] = (cursor, weight)
            cursor += weight

    def report(self, stage: str, fraction: float) -> None:
        if self._on_progress is None:
            return
        base, weight = self._offsets.get(stage, (self._high_water, 0.0))
        overall = base + weight * float(np.clip(fraction, 0.0, 1.0))
        if overall < self._high_water:
            overall = self._high_water
        self._high_water = overall
        try:
            self._on_progress(stage, float(np.clip(overall, 0.0, 1.0)))
        except Exception:  # pragma: no cover - progress must never fail a job
            pass


def separate_track(
    input_path: str | Path,
    output_dir: str | Path,
    registry: EngineRegistry | None = None,
    engine_id: str | None = None,
    model_id: str | None = None,
    stems: list[str] | tuple[str, ...] | None = None,
    device: str | None = None,
    shifts: int = 0,
    overlap: float = 0.25,
    segment: float | None = None,
    jobs: int = 0,
    analyse: bool = True,
    keep_source_copy: bool = True,
    stem_subtype: str = DEFAULT_STEM_SUBTYPE,
    on_progress: ProgressFn | None = None,
    token: CancellationToken | None = None,
) -> SeparationOutcome:
    """Run the full pipeline for one track."""
    registry = registry or EngineRegistry()
    engine, resolved_model = registry.resolve(engine_id, model_id)

    model_info = next((m for m in engine.models() if m.id == resolved_model), None)
    if model_info is None:  # pragma: no cover - resolve() guarantees this
        raise SipraError(ErrorCode.MODEL_UNAVAILABLE, f"Unknown model '{resolved_model}'")

    requested = tuple(stems) if stems else tuple(model_info.stems)
    unknown = [s for s in requested if s not in model_info.stems]
    if unknown:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            f"Model '{resolved_model}' cannot produce: {', '.join(unknown)}",
            {"available": list(model_info.stems)},
        )

    progress = _StageProgress(on_progress)
    track_dir = Path(output_dir)
    stems_dir = track_dir / "stems"
    peaks_dir = track_dir / "peaks"
    for directory in (track_dir, stems_dir, peaks_dir):
        directory.mkdir(parents=True, exist_ok=True)

    # -- decode ---------------------------------------------------------
    progress.report("decode", 0.0)
    if token:
        token.raise_if_cancelled()
    source = load_audio(input_path)
    progress.report("decode", 1.0)

    warnings: list[str] = []

    # -- separate -------------------------------------------------------
    if token:
        token.raise_if_cancelled()
    result = engine.separate(
        SeparationRequest(
            audio=source.data,
            sample_rate=source.sample_rate,
            model_id=resolved_model,
            stems=requested,
            device=device,
            shifts=shifts,
            overlap=overlap,
            segment=segment,
            jobs=jobs,
        ),
        on_progress=lambda _stage, fraction: progress.report("separate", fraction),
        token=token,
    )
    warnings.extend(result.warnings)
    progress.report("separate", 1.0)

    out_rate = result.sample_rate

    # The engine may resample (Demucs works at 44.1 kHz). Keep the source
    # copy at the engine's rate so every lane in the workspace shares one
    # timebase — mismatched rates would drift the playhead across lanes.
    if out_rate != source.sample_rate:
        from .audio_io import resample as _resample

        source = _resample(source, out_rate)

    # -- write stems ----------------------------------------------------
    if token:
        token.raise_if_cancelled()
    ordered = sort_stems(list(result.stems.keys()))
    artifacts: list[StemArtifact] = []
    for index, stem_id in enumerate(ordered):
        if token:
            token.raise_if_cancelled()
        audio = result.stems[stem_id]
        audio_path = write_audio(
            stems_dir / f"{stem_id}.wav", audio, out_rate, subtype=stem_subtype
        )
        peak_data = compute_peaks(audio, out_rate, DEFAULT_SAMPLES_PER_BUCKET)
        peaks_path = write_peaks(peaks_dir / f"{stem_id}.speaks", peak_data)
        artifacts.append(
            StemArtifact(
                stem_id=stem_id,
                audio_path=audio_path,
                peaks_path=peaks_path,
                sample_peak_db=_sample_peak_db(audio),
                rms_db=_rms_db(audio),
            )
        )
        progress.report("write", (index + 1) / max(1, len(ordered)))

    # -- source copy and its peaks --------------------------------------
    progress.report("peaks", 0.2)
    source_path = track_dir / "source.wav"
    if keep_source_copy:
        write_audio(source_path, source.data, out_rate, subtype=stem_subtype)
    source_peaks_path = write_peaks(
        peaks_dir / "source.speaks",
        compute_peaks(source.data, out_rate, DEFAULT_SAMPLES_PER_BUCKET),
    )
    progress.report("peaks", 1.0)

    # -- analysis -------------------------------------------------------
    analysis_payload: dict | None = None
    if analyse:
        if token:
            token.raise_if_cancelled()
        try:
            analysis = analyse_buffer(
                AudioBuffer(data=source.data, sample_rate=out_rate),
                on_progress=lambda _s, f: progress.report("analyse", f),
            )
            analysis_payload = analysis.to_dict()
            warnings.extend(analysis.warnings)
        except Exception as exc:
            warnings.append(f"Analysis failed: {exc}")
    progress.report("analyse", 1.0)

    device_label = result.device
    describe = getattr(engine, "describe_device", None)
    if callable(describe):
        try:
            device_label = describe(result.device)
        except Exception:  # pragma: no cover
            pass

    return SeparationOutcome(
        track_dir=track_dir,
        source_path=source_path if keep_source_copy else Path(input_path),
        source_peaks_path=source_peaks_path,
        sample_rate=out_rate,
        duration_seconds=source.duration,
        channels=source.channels,
        engine_id=result.engine_id,
        model_id=result.model_id,
        device=device_label,
        stems=artifacts,
        analysis=analysis_payload,
        warnings=warnings,
    )


def _sample_peak_db(audio: np.ndarray) -> float:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.size == 0:
        return float("-inf")
    peak = float(np.max(np.abs(arr)))
    return float(20.0 * np.log10(peak)) if peak > 1e-12 else float("-inf")


def _rms_db(audio: np.ndarray) -> float:
    arr = np.asarray(audio, dtype=np.float64)
    if arr.size == 0:
        return float("-inf")
    rms = float(np.sqrt(np.mean(np.square(arr))))
    return float(20.0 * np.log10(rms)) if rms > 1e-12 else float("-inf")


def _finite(value: float) -> float | None:
    """JSON has no -inf; a silent stem reports ``None`` instead."""
    return None if not np.isfinite(value) else round(float(value), 3)
