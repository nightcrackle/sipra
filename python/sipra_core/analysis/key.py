"""Musical key detection.

Standard Krumhansl-Schmuckler template matching: build a 12-bin chroma
profile for the track, correlate it against major and minor key profiles
rotated through all twelve tonics, and take the best match.

Two profile sets are provided. Krumhansl-Kessler is the classic, derived
from probe-tone experiments. Temperley's revision is generally better on
popular music, so it is the default here — Sipra is aimed at musicians
working with produced tracks, not classical corpora.

Confidence is the normalised margin between the best and second-best
candidate, which is far more informative than the raw correlation: a
track that correlates 0.9 with both C major and A minor is genuinely
ambiguous and should be shown as such.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

PITCH_CLASSES: tuple[str, ...] = (
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
)

# Krumhansl & Kessler (1982).
KRUMHANSL_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
KRUMHANSL_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)

# Temperley (1999), tuned on the Kostka-Payne corpus.
TEMPERLEY_MAJOR = np.array(
    [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0]
)
TEMPERLEY_MINOR = np.array(
    [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]
)

PROFILES: dict[str, tuple[np.ndarray, np.ndarray]] = {
    "krumhansl": (KRUMHANSL_MAJOR, KRUMHANSL_MINOR),
    "temperley": (TEMPERLEY_MAJOR, TEMPERLEY_MINOR),
}

DEFAULT_PROFILE = "temperley"

MIN_DURATION_SECONDS = 1.0
ANALYSIS_SAMPLE_RATE = 22050

# Camelot wheel positions, indexed by pitch class.
_CAMELOT_MAJOR = {
    "C": "8B", "C#": "3B", "D": "10B", "D#": "5B", "E": "12B", "F": "7B",
    "F#": "2B", "G": "9B", "G#": "4B", "A": "11B", "A#": "6B", "B": "1B",
}
_CAMELOT_MINOR = {
    "A": "8A", "A#": "3A", "B": "10A", "C": "5A", "C#": "12A", "D": "7A",
    "D#": "2A", "E": "9A", "F": "4A", "F#": "11A", "G": "6A", "G#": "1A",
}


@dataclass(frozen=True)
class KeyEstimate:
    tonic: str | None
    scale: str | None  # "major" | "minor"
    confidence: float
    camelot: str | None

    @property
    def label(self) -> str:
        if not self.tonic or not self.scale:
            return "Unknown"
        return f"{self.tonic} {self.scale}"

    def to_dict(self) -> dict:
        return {
            "key": self.tonic,
            "scale": self.scale,
            "keyLabel": self.label,
            "keyConfidence": round(self.confidence, 3),
            "camelot": self.camelot,
        }


def camelot_for(tonic: str, scale: str) -> str | None:
    table = _CAMELOT_MAJOR if scale == "major" else _CAMELOT_MINOR
    return table.get(tonic)


def chroma_profile(mono: np.ndarray, sample_rate: int) -> np.ndarray | None:
    """Time-averaged 12-bin chroma vector, or ``None`` if unmeasurable."""
    arr = np.asarray(mono, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.mean(axis=0, dtype=np.float32)
    if sample_rate <= 0:
        return None
    if arr.size / float(sample_rate) < MIN_DURATION_SECONDS:
        return None
    if float(np.max(np.abs(arr))) <= 1e-9:
        return None

    try:
        import librosa
    except ImportError:  # pragma: no cover
        return None

    if sample_rate != ANALYSIS_SAMPLE_RATE:
        arr = librosa.resample(
            arr, orig_sr=sample_rate, target_sr=ANALYSIS_SAMPLE_RATE, res_type="soxr_hq"
        )
    sr = ANALYSIS_SAMPLE_RATE

    try:
        # Harmonic separation keeps drum transients from smearing the
        # chroma across all twelve bins.
        harmonic = librosa.effects.harmonic(arr, margin=2.0)
        chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, bins_per_octave=36)
    except Exception:  # pragma: no cover - defensive
        try:
            chroma = librosa.feature.chroma_stft(y=arr, sr=sr)
        except Exception:
            return None

    if chroma.size == 0:
        return None
    profile = chroma.mean(axis=1).astype(np.float64)
    total = float(profile.sum())
    if total <= 0:
        return None
    return profile / total


def detect_from_chroma(
    profile: np.ndarray, profile_set: str = DEFAULT_PROFILE
) -> KeyEstimate:
    """Match a 12-bin chroma vector against all 24 key templates."""
    if profile_set not in PROFILES:
        profile_set = DEFAULT_PROFILE
    major_template, minor_template = PROFILES[profile_set]

    vec = np.asarray(profile, dtype=np.float64).reshape(-1)
    if vec.size != 12 or not np.isfinite(vec).all() or float(np.sum(vec)) <= 0:
        return KeyEstimate(None, None, 0.0, None)

    scores: list[tuple[float, str, str]] = []
    for index in range(12):
        rotated = np.roll(vec, -index)
        scores.append((_correlate(rotated, major_template), PITCH_CLASSES[index], "major"))
        scores.append((_correlate(rotated, minor_template), PITCH_CLASSES[index], "minor"))

    scores.sort(key=lambda item: item[0], reverse=True)
    best_score, tonic, scale = scores[0]
    runner_up = scores[1][0]

    if not np.isfinite(best_score) or best_score <= 0:
        return KeyEstimate(None, None, 0.0, None)

    margin = (best_score - runner_up) / abs(best_score) if best_score else 0.0
    confidence = float(np.clip(margin / 0.35, 0.0, 1.0))

    return KeyEstimate(
        tonic=tonic,
        scale=scale,
        confidence=confidence,
        camelot=camelot_for(tonic, scale),
    )


def estimate(
    mono: np.ndarray, sample_rate: int, profile_set: str = DEFAULT_PROFILE
) -> KeyEstimate:
    profile = chroma_profile(mono, sample_rate)
    if profile is None:
        return KeyEstimate(None, None, 0.0, None)
    return detect_from_chroma(profile, profile_set)


def _correlate(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson correlation, returning 0 for a degenerate input."""
    a_centred = a - a.mean()
    b_centred = b - b.mean()
    denominator = float(np.linalg.norm(a_centred) * np.linalg.norm(b_centred))
    if denominator <= 1e-12:
        return 0.0
    return float(np.dot(a_centred, b_centred) / denominator)
