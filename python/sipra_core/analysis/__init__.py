"""Audio analysis: tempo, key, loudness and peak measurement."""

from __future__ import annotations

from . import key, loudness, tempo
from .analyze import TrackAnalysis, analyse_buffer, analyse_file, analyse_file_bounded

__all__ = [
    "TrackAnalysis",
    "analyse_buffer",
    "analyse_file",
    "analyse_file_bounded",
    "key",
    "loudness",
    "tempo",
]
