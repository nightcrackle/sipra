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
from .trace import trace, trace_memory
from .waveform import DEFAULT_SAMPLES_PER_BUCKET, compute_peaks, write_peaks

ProgressFn = Callable[[str, float], None]

# Fraction of the overall job each stage is worth. Separation dominates by
# so much that everything else is rounding error, but a bar that sits at
# 100% for ten seconds while peaks are written feels broken, so the tail
# stages get a visible slice.
#
# ``collect`` exists to break a tie. Before it, the end of ``separate``
# and the start of ``write`` both landed on exactly 0.80, so a bar sitting
# at 80% could mean the model was still finishing, or that the model had
# finished and the first stem was being written — two different bugs with
# one appearance. The work it names is real: moving each separated tensor
# off the compute device and back into a numpy array.
#
# ``model`` covers fetching and loading the separation model, and the
# first inference that makes the compute device compile its kernels. On
# every run after the first this is a second or two. On the first run it
# is a download of tens of megabytes followed by a cold start, and it used
# to report nothing at all — so the first track anyone separated after
# installing appeared to stop dead a few percent into separation. It has
# its own stage now so the app can say what it is doing.
STAGE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("decode", 0.06),
    ("model", 0.04),
    ("separate", 0.66),
    ("collect", 0.04),
    ("write", 0.08),
    ("peaks", 0.06),
    ("analyse", 0.06),
)

DEFAULT_STEM_SUBTYPE = "PCM_16"

#: How much of the ``collect`` stage belongs to the engine's own
#: device-to-host transfer. The remainder covers resampling the source
#: copy to the engine's rate, which happens for every 48 kHz import.
ENGINE_SHARE_OF_COLLECT = 0.8


def _log_stage(message: str, **fields: object) -> None:
    """Announce a pipeline step. See :mod:`sipra_core.trace`."""
    trace(message, **fields)


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

    # Decode straight to the model's rate.
    #
    # Every path that did not do this converted the audio twice: once
    # inside the engine to give the model its input, and once afterwards to
    # bring the source copy back onto the stems' timebase. The second
    # conversion sat between the end of separation and the first stem
    # write, with the whole result set still in memory, reporting nothing —
    # which is exactly where a user's job stopped at 86% and never moved.
    # Asking the decoder for the right rate makes both conversions
    # unnecessary, and hands the work to ffmpeg, which does it while
    # streaming and while nothing else is allocated.
    engine_rate = int(getattr(model_info, "sample_rate", 0) or 0)
    _log_stage(f"decoding {Path(input_path).name}", at=engine_rate or "source rate")
    source = load_audio(
        input_path,
        target_sample_rate=engine_rate or None,
        # Decoding is the first 6% of the bar; a rate conversion here gets
        # the back half of it rather than happening in silence.
        on_progress=lambda f: progress.report("decode", f),
        # So Cancel works during a long decode instead of waiting it out.
        token=token,
    )
    progress.report("decode", 1.0)
    _log_stage(
        "decoded",
        rate=source.sample_rate,
        channels=source.data.shape[0],
        seconds=round(source.data.shape[1] / max(1, source.sample_rate), 1),
    )

    warnings: list[str] = []

    # -- separate -------------------------------------------------------
    if token:
        token.raise_if_cancelled()
    _log_stage(f"separating with {engine.id}/{resolved_model}", device=device or "auto")

    # The engine names its own stage so that the device-transfer tail of a
    # separation is distinguishable from the model run itself; anything it
    # does not name counts as separation. The engine's share of `collect`
    # is capped below the whole so the source resample that follows it has
    # a band of its own — otherwise a stall in the resample would be
    # indistinguishable from a stall in the first stem write.
    def _engine_progress(stage: str, fraction: float) -> None:
        if stage == "collect":
            progress.report("collect", fraction * ENGINE_SHARE_OF_COLLECT)
        elif stage == "model":
            progress.report("model", fraction)
        else:
            progress.report("separate", fraction)

    # Entering the stage before the engine does, so the label is right from
    # the moment the work starts rather than from the engine's first report.
    progress.report("model", 0.0)

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
        on_progress=_engine_progress,
        token=token,
    )
    warnings.extend(result.warnings)
    progress.report("collect", 1.0)
    _log_stage("separated", stems=len(result.stems), rate=result.sample_rate)
    # The high-water mark of the whole run: the source and every stem are
    # resident at once here. If a machine is going to run short, this is
    # where it happens, and this is the line that will say so.
    trace_memory("memory after separation")

    out_rate = result.sample_rate

    # The engine may resample (Demucs works at 44.1 kHz). Keep the source
    # copy at the engine's rate so every lane in the workspace shares one
    # timebase — mismatched rates would drift the playhead across lanes.
    if out_rate != source.sample_rate:
        from .audio_io import resample as _resample

        # Decoding at the model's declared rate normally makes this
        # unreachable. It stays as a backstop for an engine whose actual
        # output rate differs from what it declared — but it now reports
        # and traces, because the last time it ran unreported a job stopped
        # here at 86% and gave no indication of what it was doing.
        _log_stage("resampling the source copy", frm=source.sample_rate, to=out_rate)
        source = _resample(
            source,
            out_rate,
            on_progress=lambda f: progress.report(
                "collect", ENGINE_SHARE_OF_COLLECT + (1 - ENGINE_SHARE_OF_COLLECT) * f
            ),
        )
        _log_stage("resampled")

    # -- write stems ----------------------------------------------------
    if token:
        token.raise_if_cancelled()
    ordered = sort_stems(list(result.stems.keys()))
    artifacts: list[StemArtifact] = []
    total_stems = max(1, len(ordered))

    for index, stem_id in enumerate(ordered):
        if token:
            token.raise_if_cancelled()

        # Report *before* the work as well as after. Writing a stem of a
        # long track is tens of megabytes of clipping, transposing and
        # disk I/O; reporting only on completion leaves the bar sitting on
        # the previous stage's boundary for the whole of it, which reads as
        # a freeze rather than as progress.
        progress.report("write", index / total_stems)
        _log_stage(f"writing {stem_id}")

        audio = result.stems[stem_id]
        audio_path = write_audio(
            stems_dir / f"{stem_id}.wav", audio, out_rate, subtype=stem_subtype
        )
        progress.report("write", (index + 0.5) / total_stems)

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

        # Release each stem as soon as it is on disk. Six stems of a long
        # track held together with the source and whatever the engine has
        # not freed is enough to push a 16 GB machine into swap, which is
        # what turns "slow" into "frozen".
        result.stems.pop(stem_id, None)
        del audio

        progress.report("write", (index + 1) / total_stems)

    # -- source copy and its peaks --------------------------------------
    #
    # Each step announces itself. Everything from here on is numpy and
    # scipy work of the same kind as the conversion that once stopped a job
    # dead, so if that ever happens again the log names which one.
    progress.report("peaks", 0.1)
    source_path = track_dir / "source.wav"
    if keep_source_copy:
        _log_stage("writing the source copy")
        write_audio(source_path, source.data, out_rate, subtype=stem_subtype)
        progress.report("peaks", 0.4)
    _log_stage("drawing the source waveform")
    source_peaks_path = write_peaks(
        peaks_dir / "source.speaks",
        compute_peaks(source.data, out_rate, DEFAULT_SAMPLES_PER_BUCKET),
    )
    progress.report("peaks", 1.0)
    _log_stage("source waveform written")

    # -- analysis -------------------------------------------------------
    analysis_payload: dict | None = None
    if analyse:
        if token:
            token.raise_if_cancelled()
        # The first analysis in a process pays numba's JIT compilation,
        # which can take the better part of a minute on a cold machine.
        trace_memory("memory before analysis")
        _log_stage("measuring tempo, key and loudness")
        try:
            analysis = analyse_buffer(
                AudioBuffer(data=source.data, sample_rate=out_rate),
                on_progress=lambda _s, f: progress.report("analyse", f),
            )
            analysis_payload = analysis.to_dict()
            warnings.extend(analysis.warnings)
            _log_stage("analysis finished")
        except Exception as exc:
            warnings.append(f"Analysis failed: {exc}")
            _log_stage("analysis failed", error=str(exc)[:200])
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
