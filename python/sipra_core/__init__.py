"""Sipra's audio core.

Everything that touches audio — decoding, separation, analysis, waveform
peaks and mixdown — lives here and runs as a sidecar process next to the
Electron app. Nothing in this package makes a network request except the
optional URL ingest in :mod:`sipra_core.ingest.youtube` and the one-time
model-weight download performed by the separation engine.
"""

from __future__ import annotations

__version__ = "0.9.0"
__all__ = ["__version__"]
