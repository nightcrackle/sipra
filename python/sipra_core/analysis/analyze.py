"""Top-level analysis orchestration.

One decode, one mono downmix, then tempo / key / loudness measured from
that shared work. Each measurement is independently fallible: if key
detection blows up we still want the BPM and the loudness numbers, so
every stage is individually guarded and simply reports ``None`` on
failure rather than sinking the whole analysis.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..audio_io import AudioBuffer, load_audio
from ..errors import CancelledError
from . import key as key_mod
from . import loudness as loudness_mod
from . import tempo as tempo_mod

ProgressFn = Callable[[str, float], None]

# Tempo and key are both computed on a mono downmix at this rate.
ANALYSIS_SAMPLE_RATE = 22050


@dataclass
class TrackAnalysis:
    duration_seconds: float
    sample_rate: int
    channels: int
    tempo: tempo_mod.TempoEstimate | None = None
    key: key_mod.KeyEstimate | None = None
    loudness: loudness_mod.LoudnessStats | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self, include_beats: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "durationSeconds": round(self.duration_seconds, 4),
            "sampleRate": self.sample_rate,
            "channels": self.channels,
        }
        payload.update(
            self.tempo.to_dict(include_beats)
            if self.tempo
            else {"bpm": None, "bpmConfidence": 0.0}
        )
        payload.update(
            self.key.to_dict()
            if self.key
            else {
                "key": None,
                "scale": None,
                "keyLabel": "Unknown",
                "keyConfidence": 0.0,
                "camelot": None,
            }
        )
        payload.update(
            self.loudness.to_dict()
            if self.loudness
            else {
                "integratedLufs": None,
                "loudnessRangeLu": None,
                "samplePeakDb": None,
                "truePeakDb": None,
                "rmsDb": None,
                "crestFactorDb": None,
            }
        )
        if self.warnings:
            payload["warnings"] = list(self.warnings)
        return payload


def analyse_buffer(
    buf: AudioBuffer,
    include_beats: bool = False,
    key_profile: str = key_mod.DEFAULT_PROFILE,
    on_progress: ProgressFn | None = None,
    token: object | None = None,
) -> TrackAnalysis:
    """Measure tempo, key and loudness for an already-decoded buffer.

    ``token`` is checked between measurements. Analysis is the last stage
    of a separation and the slowest on a cold machine — parts of librosa
    compile on first use — so it is exactly where a user is most likely to
    give up, and until now the only stage that ignored them entirely.
    Cancelling during it did nothing at all.
    """
    def check_cancelled() -> None:
        if token is not None and getattr(token, "cancelled", False):
            raise CancelledError("Analysis cancelled")

    result = TrackAnalysis(
        duration_seconds=buf.duration,
        sample_rate=buf.sample_rate,
        channels=buf.channels,
    )

    def report(stage: str, fraction: float) -> None:
        if on_progress is not None:
            try:
                on_progress(stage, fraction)
            except Exception:  # pragma: no cover - progress must never fail a job
                pass

    check_cancelled()
    report("loudness", 0.05)
    try:
        result.loudness = loudness_mod.measure(buf.data, buf.sample_rate)
    except Exception as exc:
        result.warnings.append(f"Loudness analysis failed: {exc}")

    check_cancelled()
    report("downmix", 0.35)
    mono: np.ndarray | None = None
    try:
        mono = buf.to_mono()
        if buf.sample_rate != ANALYSIS_SAMPLE_RATE and mono.size:
            import librosa

            mono = librosa.resample(
                mono,
                orig_sr=buf.sample_rate,
                target_sr=ANALYSIS_SAMPLE_RATE,
                res_type="soxr_hq",
            )
        analysis_rate = ANALYSIS_SAMPLE_RATE if mono is not None else buf.sample_rate
    except Exception as exc:
        result.warnings.append(f"Downmix failed: {exc}")
        mono = None
        analysis_rate = buf.sample_rate

    check_cancelled()
    report("tempo", 0.45)
    if mono is not None:
        try:
            result.tempo = tempo_mod.estimate(mono, analysis_rate)
        except Exception as exc:
            result.warnings.append(f"Tempo analysis failed: {exc}")

    check_cancelled()
    report("key", 0.75)
    if mono is not None:
        try:
            result.key = key_mod.estimate(mono, analysis_rate, key_profile)
        except Exception as exc:
            result.warnings.append(f"Key analysis failed: {exc}")

    report("done", 1.0)
    return result


def analyse_file(
    path: str | Path,
    include_beats: bool = False,
    key_profile: str = key_mod.DEFAULT_PROFILE,
    on_progress: ProgressFn | None = None,
) -> TrackAnalysis:
    """Decode ``path`` and analyse it."""
    buf = load_audio(path)
    return analyse_buffer(
        buf,
        include_beats=include_beats,
        key_profile=key_profile,
        on_progress=on_progress,
    )
