"""Tempo estimation.

Beat tracking is delegated to librosa's dynamic-programming tracker. On
top of that we add two things librosa does not give you:

* an **octave correction** pass, because beat trackers routinely land on
  half or double the musically obvious tempo;
* a **confidence** figure derived from how regular the detected beat
  intervals actually are, so the UI can show an estimate as uncertain
  instead of stating a wrong number with total confidence.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# The range most produced music sits in. Estimates outside it are folded
# back by doubling or halving.
MIN_BPM = 60.0
MAX_BPM = 190.0

# Beat tracking on less than this is not meaningful.
MIN_DURATION_SECONDS = 3.0

ANALYSIS_SAMPLE_RATE = 22050


@dataclass(frozen=True)
class TempoEstimate:
    bpm: float | None
    confidence: float
    beat_times: list[float]

    def to_dict(self, include_beats: bool = False) -> dict:
        payload: dict = {
            "bpm": round(self.bpm, 2) if self.bpm is not None else None,
            "bpmConfidence": round(self.confidence, 3),
        }
        if include_beats:
            payload["beatTimes"] = [round(t, 4) for t in self.beat_times]
        return payload


def fold_to_range(bpm: float, low: float = MIN_BPM, high: float = MAX_BPM) -> float:
    """Double or halve ``bpm`` until it lands inside ``[low, high]``.

    Gives up after a bounded number of steps so an absurd input (0, inf)
    cannot spin forever.
    """
    if not np.isfinite(bpm) or bpm <= 0:
        return bpm
    value = float(bpm)
    for _ in range(8):
        if value < low:
            value *= 2.0
        elif value > high:
            value /= 2.0
        else:
            break
    return value


def estimate(
    mono: np.ndarray,
    sample_rate: int,
    fold: bool = True,
) -> TempoEstimate:
    """Estimate tempo from a mono signal."""
    arr = np.asarray(mono, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=0, dtype=np.float32)

    duration = arr.size / float(sample_rate) if sample_rate else 0.0
    if duration < MIN_DURATION_SECONDS or float(np.max(np.abs(arr))) <= 1e-9:
        return TempoEstimate(bpm=None, confidence=0.0, beat_times=[])

    try:
        import librosa
    except ImportError:  # pragma: no cover - librosa is a hard dependency
        return TempoEstimate(bpm=None, confidence=0.0, beat_times=[])

    if sample_rate != ANALYSIS_SAMPLE_RATE:
        arr = librosa.resample(
            arr, orig_sr=sample_rate, target_sr=ANALYSIS_SAMPLE_RATE, res_type="soxr_hq"
        )
    sr = ANALYSIS_SAMPLE_RATE

    try:
        onset_env = librosa.onset.onset_strength(y=arr, sr=sr, aggregate=np.median)
        tempo_raw, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, trim=False, units="frames"
        )
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    except Exception:  # pragma: no cover - defensive
        return TempoEstimate(bpm=None, confidence=0.0, beat_times=[])

    bpm = float(np.atleast_1d(np.asarray(tempo_raw, dtype=float))[0])

    # Only trust the beat-derived tempo when it agrees with the tempogram
    # to within about 10%. A large disagreement usually means the beat
    # track dropped or doubled beats, in which case the tempogram peak is
    # the safer estimate.
    refined = refine_from_beats(beat_times)
    if refined is not None and bpm > 0 and 0.9 <= (refined / bpm) <= 1.1:
        bpm = refined

    if fold:
        bpm = fold_to_range(bpm)

    return TempoEstimate(
        bpm=bpm if np.isfinite(bpm) and bpm > 0 else None,
        confidence=_confidence(beat_times),
        beat_times=[float(t) for t in beat_times],
    )


def refine_from_beats(beat_times: list[float]) -> float | None:
    """Recover a precise tempo from detected beat positions.

    Beat times are quantised to the analysis hop (~23 ms), so taking the
    median inter-beat interval inherits that quantisation and can be a
    couple of BPM out. Least-squares fitting a straight line through
    ``(beat_index, beat_time)`` averages the quantisation error across
    every beat and recovers the underlying period far more accurately.

    Beats whose spacing is wildly different from the median are dropped
    first, so a single missed or doubled beat cannot drag the fit.
    """
    if len(beat_times) < 4:
        return None

    times = np.asarray(beat_times, dtype=float)
    intervals = np.diff(times)
    positive = intervals[intervals > 1e-6]
    if positive.size < 3:
        return None

    median_interval = float(np.median(positive))
    if median_interval <= 0:
        return None

    # Keep the longest run of consecutive beats spaced within 25% of the
    # median; a fit across a dropped beat would halve the tempo.
    keep = np.concatenate([[True], np.abs(intervals - median_interval) <= 0.25 * median_interval])
    best_start, best_len, run_start = 0, 0, 0
    for i, ok in enumerate(keep):
        if ok:
            if i - run_start + 1 > best_len:
                best_len = i - run_start + 1
                best_start = run_start
        else:
            run_start = i
    if best_len < 4:
        return None

    segment = times[best_start : best_start + best_len]
    indices = np.arange(segment.size, dtype=float)
    slope, _intercept = np.polyfit(indices, segment, 1)
    if not np.isfinite(slope) or slope <= 1e-6:
        return None
    return float(60.0 / slope)


def _confidence(beat_times: list[float]) -> float:
    """How steady are the detected beats, as a 0-1 score.

    Uses the coefficient of variation of inter-beat intervals: a metronome
    scores ~1.0, a track the tracker is guessing at scores near 0.
    """
    if len(beat_times) < 4:
        return 0.0
    intervals = np.diff(np.asarray(beat_times, dtype=float))
    intervals = intervals[intervals > 1e-6]
    if intervals.size < 3:
        return 0.0
    mean = float(np.mean(intervals))
    if mean <= 0:
        return 0.0
    cv = float(np.std(intervals) / mean)
    # cv of 0 -> 1.0, cv of 0.25 or worse -> 0.0
    return float(np.clip(1.0 - (cv / 0.25), 0.0, 1.0))
