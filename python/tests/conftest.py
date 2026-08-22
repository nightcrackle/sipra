"""Shared fixtures: synthesised audio with known, checkable properties.

Every signal here is generated rather than loaded from a fixture file, so
the tests assert against maths we can reason about (a -20 dBFS sine really
is -20 dBFS) instead of against whatever a checked-in WAV happens to
contain.
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

SAMPLE_RATE = 44100
ANALYSIS_RATE = 22050


@pytest.fixture(scope="session")
def sample_rate() -> int:
    return SAMPLE_RATE


def sine(
    frequency: float,
    duration: float,
    sample_rate: int = SAMPLE_RATE,
    amplitude: float = 1.0,
    phase: float = 0.0,
) -> np.ndarray:
    t = np.arange(int(sample_rate * duration), dtype=np.float64) / sample_rate
    return (amplitude * np.sin(2 * np.pi * frequency * t + phase)).astype(np.float32)


def dbfs_sine(
    db: float, frequency: float = 1000.0, duration: float = 3.0, sample_rate: int = SAMPLE_RATE
) -> np.ndarray:
    return sine(frequency, duration, sample_rate, amplitude=10.0 ** (db / 20.0))


def stereo(mono: np.ndarray) -> np.ndarray:
    """Duplicate a mono signal into a (2, N) stereo array."""
    return np.stack([mono, mono]).astype(np.float32)


def click_track(
    bpm: float,
    duration: float = 16.0,
    sample_rate: int = ANALYSIS_RATE,
    seed: int = 0,
) -> np.ndarray:
    """A percussive click every beat — a tempo the tracker should nail."""
    total = int(sample_rate * duration)
    out = np.zeros(total, dtype=np.float32)
    rng = np.random.RandomState(seed)
    click = (np.exp(-np.linspace(0, 12, 400)) * rng.randn(400)).astype(np.float32)
    period = sample_rate * 60.0 / bpm
    position = 0.0
    while int(position) + click.size < total:
        start = int(round(position))
        out[start : start + click.size] += click
        position += period
    peak = float(np.max(np.abs(out)))
    return (out / peak).astype(np.float32) if peak > 0 else out


def harmonic_tone(frequency: float, duration: float, sample_rate: int = ANALYSIS_RATE) -> np.ndarray:
    """A tone with a few harmonics, so chroma analysis has something to bite on."""
    total = np.zeros(int(sample_rate * duration), dtype=np.float32)
    for harmonic in (1, 2, 3, 4):
        total += sine(frequency * harmonic, duration, sample_rate, 1.0 / (harmonic**1.5))
    return total


def chord(frequencies, duration: float = 1.5, sample_rate: int = ANALYSIS_RATE) -> np.ndarray:
    stacked = np.zeros(int(sample_rate * duration), dtype=np.float32)
    for frequency in frequencies:
        stacked += harmonic_tone(frequency, duration, sample_rate)
    return stacked


def progression(chords, repeats: int = 3, sample_rate: int = ANALYSIS_RATE) -> np.ndarray:
    signal = np.concatenate([chord(c, sample_rate=sample_rate) for c in chords] * repeats)
    peak = float(np.max(np.abs(signal)))
    return (signal / peak).astype(np.float32) if peak > 0 else signal


# Reference frequencies, octave 3-4.
NOTE = {
    "C3": 130.81, "D3": 146.83, "E3": 164.81, "F3": 174.61, "G3": 196.00,
    "A3": 220.00, "B3": 246.94,
    "C4": 261.63, "D4": 293.66, "E4": 329.63, "F4": 349.23, "G4": 392.00,
    "A4": 440.00, "B4": 493.88,
    "Gs3": 207.65, "Fs4": 369.99, "Bf3": 233.08, "Cs4": 277.18,
}


@pytest.fixture
def wav_file(tmp_path):
    """Factory writing a (channels, samples) array to a real WAV on disk."""

    def _write(data: np.ndarray, name: str = "test.wav", rate: int = SAMPLE_RATE) -> str:
        arr = np.asarray(data, dtype=np.float32)
        if arr.ndim == 1:
            arr = arr[np.newaxis, :]
        path = tmp_path / name
        sf.write(str(path), arr.T, rate, subtype="FLOAT")
        return str(path)

    return _write


@pytest.fixture(scope="session")
def music_like() -> np.ndarray:
    """A short stereo signal with bass, a mid chord and a hat pattern.

    Not music, but it has energy across the spectrum and a steady pulse,
    which is enough to exercise the full pipeline realistically.
    """
    rate = SAMPLE_RATE
    duration = 6.0
    bass = sine(82.41, duration, rate, 0.5)
    mid = (
        sine(NOTE["C4"], duration, rate, 0.18)
        + sine(NOTE["E4"], duration, rate, 0.15)
        + sine(NOTE["G4"], duration, rate, 0.15)
    )
    hats = np.zeros(int(rate * duration), dtype=np.float32)
    rng = np.random.RandomState(7)
    burst = (np.exp(-np.linspace(0, 20, 800)) * rng.randn(800) * 0.35).astype(np.float32)
    step = int(rate * 0.25)
    for start in range(0, hats.size - burst.size, step):
        hats[start : start + burst.size] += burst
    mono = (bass + mid + hats).astype(np.float32)
    mono /= max(float(np.max(np.abs(mono))), 1e-9) * 1.2
    return np.stack([mono, mono * 0.92]).astype(np.float32)
