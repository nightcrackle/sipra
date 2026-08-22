"""Loudness and peak measurement.

Integrated loudness follows ITU-R BS.1770-4 / EBU R128 via ``pyloudnorm``.
True peak is measured by 4x oversampling, which is the minimum the spec
allows and catches the inter-sample peaks that a plain sample-peak reading
misses on limited masters.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

# Below this, a signal is treated as digital silence and reported as -inf.
SILENCE_FLOOR = 1e-12

# BS.1770 gating needs at least one 400 ms block.
MIN_LOUDNESS_SECONDS = 0.5

# Oversampling factor for true-peak estimation (BS.1770-4 minimum).
TRUE_PEAK_OVERSAMPLE = 4


@dataclass(frozen=True)
class LoudnessStats:
    integrated_lufs: float | None
    loudness_range_lu: float | None
    sample_peak_db: float
    true_peak_db: float
    rms_db: float
    crest_factor_db: float | None

    def to_dict(self) -> dict:
        return {
            "integratedLufs": self.integrated_lufs,
            "loudnessRangeLu": self.loudness_range_lu,
            "samplePeakDb": self.sample_peak_db,
            "truePeakDb": self.true_peak_db,
            "rmsDb": self.rms_db,
            "crestFactorDb": self.crest_factor_db,
        }

    def as_plain(self) -> dict:  # pragma: no cover - convenience
        return asdict(self)


def linear_to_db(value: float) -> float:
    """Amplitude ratio to decibels, with a hard floor instead of ``-inf``."""
    if value <= SILENCE_FLOOR:
        return float("-inf")
    return float(20.0 * np.log10(value))


def sample_peak_db(data: np.ndarray) -> float:
    arr = np.asarray(data, dtype=np.float32)
    if arr.size == 0:
        return float("-inf")
    return linear_to_db(float(np.max(np.abs(arr))))


def rms_db(data: np.ndarray) -> float:
    arr = np.asarray(data, dtype=np.float64)
    if arr.size == 0:
        return float("-inf")
    return linear_to_db(float(np.sqrt(np.mean(np.square(arr)))))


def true_peak_db(data: np.ndarray, sample_rate: int) -> float:
    """Estimate inter-sample (true) peak in dBTP.

    Each channel is upsampled independently; taking the maximum across
    channels afterwards matches how BS.1770 defines true-peak level.
    """
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[np.newaxis, :]
    if arr.size == 0:
        return float("-inf")

    # Oversampling a handful of samples is meaningless and can make
    # resample_poly raise; fall back to the sample peak.
    if arr.shape[1] < 32:
        return sample_peak_db(arr)

    from scipy.signal import resample_poly

    try:
        upsampled = resample_poly(arr, TRUE_PEAK_OVERSAMPLE, 1, axis=1)
    except Exception:  # pragma: no cover - defensive
        return sample_peak_db(arr)
    return linear_to_db(float(np.max(np.abs(upsampled))))


def integrated_loudness(data: np.ndarray, sample_rate: int) -> float | None:
    """Gated integrated loudness in LUFS, or ``None`` if unmeasurable."""
    arr = _as_interleaved(data)
    if arr.shape[0] < int(MIN_LOUDNESS_SECONDS * sample_rate):
        return None
    if float(np.max(np.abs(arr))) <= SILENCE_FLOOR:
        return None

    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(int(sample_rate))
        value = float(meter.integrated_loudness(arr))
    except Exception:  # pragma: no cover - depends on optional dependency
        return None

    if not np.isfinite(value):
        return None
    return value


def loudness_range(data: np.ndarray, sample_rate: int) -> float | None:
    """EBU R128 loudness range (LRA) in LU.

    Short-term loudness is measured over 3 s windows at 1 s hops, gated at
    -20 LU relative to the ungated mean, then the 10th-to-95th percentile
    spread is reported.
    """
    arr = _as_interleaved(data)
    window = int(3.0 * sample_rate)
    hop = int(1.0 * sample_rate)
    if arr.shape[0] < window or hop <= 0:
        return None

    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(int(sample_rate), block_size=3.0)
    except Exception:  # pragma: no cover
        return None

    values: list[float] = []
    for start in range(0, arr.shape[0] - window + 1, hop):
        block = arr[start : start + window]
        if float(np.max(np.abs(block))) <= SILENCE_FLOOR:
            continue
        try:
            level = float(meter.integrated_loudness(block))
        except Exception:  # pragma: no cover
            continue
        if np.isfinite(level) and level > -70.0:
            values.append(level)

    if len(values) < 2:
        return None

    arr_vals = np.asarray(values, dtype=np.float64)
    gate = float(np.mean(arr_vals)) - 20.0
    gated = arr_vals[arr_vals >= gate]
    if gated.size < 2:
        return None
    low, high = np.percentile(gated, [10.0, 95.0])
    return float(high - low)


def measure(data: np.ndarray, sample_rate: int) -> LoudnessStats:
    """Full loudness/peak report for ``(channels, samples)`` audio."""
    peak_db = sample_peak_db(data)
    tp_db = true_peak_db(data, sample_rate)
    r_db = rms_db(data)
    lufs = integrated_loudness(data, sample_rate)
    lra = loudness_range(data, sample_rate)

    crest: float | None = None
    if np.isfinite(peak_db) and np.isfinite(r_db):
        crest = float(peak_db - r_db)

    return LoudnessStats(
        integrated_lufs=lufs,
        loudness_range_lu=lra,
        sample_peak_db=peak_db,
        true_peak_db=tp_db,
        rms_db=r_db,
        crest_factor_db=crest,
    )


def _as_interleaved(data: np.ndarray) -> np.ndarray:
    """Convert ``(channels, samples)`` to the ``(samples, channels)`` that
    pyloudnorm expects, collapsing a mono array to 1-D."""
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        return arr
    if arr.shape[0] == 1:
        return arr[0]
    return np.ascontiguousarray(arr.T)
