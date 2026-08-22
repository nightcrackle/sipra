"""Waveform peak generation.

The renderer paints lanes from a precomputed min/max envelope rather than
from decoded audio, so a waveform appears the instant a track opens
instead of after several hundred megabytes have been decoded.

Binary layout (little-endian), file extension ``.speaks``::

    offset  size  field
    0       5     magic  b"SPKS1"
    5       1     uint8   version
    6       2     uint16  reserved (0)
    8       4     uint32  sampleRate
    12      4     uint32  samplesPerBucket
    16      4     uint32  bucketCount
    20      4     uint32  sourceChannels
    24      8     float64 durationSeconds
    32      ...   int16[bucketCount * 2]   interleaved (min, max)

Peaks are channel-summed to mono and stored as signed 16-bit fixed point
scaled by 32767, which is 4x smaller than float32 and visually
indistinguishable at display resolution.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .errors import ErrorCode, SipraError

MAGIC = b"SPKS1"
VERSION = 1
HEADER_SIZE = 32
DEFAULT_SAMPLES_PER_BUCKET = 256
INT16_SCALE = 32767.0


@dataclass(frozen=True)
class PeakData:
    """Decoded peak envelope."""

    sample_rate: int
    samples_per_bucket: int
    source_channels: int
    duration_seconds: float
    minima: np.ndarray  # float32 in [-1, 1]
    maxima: np.ndarray  # float32 in [-1, 1]

    @property
    def bucket_count(self) -> int:
        return int(self.minima.shape[0])


def compute_peaks(
    data: np.ndarray,
    sample_rate: int,
    samples_per_bucket: int = DEFAULT_SAMPLES_PER_BUCKET,
) -> PeakData:
    """Reduce ``(channels, samples)`` audio to a min/max envelope.

    A partial final bucket is kept rather than dropped, so the envelope
    always spans the full duration and the playhead never runs off the
    end of the drawn waveform.
    """
    if samples_per_bucket < 1:
        raise SipraError(ErrorCode.INVALID_PARAMS, "samples_per_bucket must be >= 1")

    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[np.newaxis, :]
    if arr.ndim != 2:
        raise SipraError(ErrorCode.INTERNAL, f"Expected 2-D audio, got {arr.shape}")

    channels, frames = arr.shape
    mono = arr[0] if channels == 1 else arr.mean(axis=0, dtype=np.float32)

    if frames == 0:
        empty = np.zeros(0, dtype=np.float32)
        return PeakData(
            sample_rate=int(sample_rate),
            samples_per_bucket=int(samples_per_bucket),
            source_channels=int(channels),
            duration_seconds=0.0,
            minima=empty,
            maxima=empty.copy(),
        )

    bucket_count = int(np.ceil(frames / samples_per_bucket))
    padded_len = bucket_count * samples_per_bucket
    if padded_len != frames:
        # Pad the tail with the final sample value rather than zeros, so a
        # track that fades out does not gain a spurious spike to silence.
        pad = np.full(padded_len - frames, mono[-1], dtype=np.float32)
        mono = np.concatenate([mono, pad])

    shaped = mono.reshape(bucket_count, samples_per_bucket)
    minima = shaped.min(axis=1).astype(np.float32, copy=False)
    maxima = shaped.max(axis=1).astype(np.float32, copy=False)

    return PeakData(
        sample_rate=int(sample_rate),
        samples_per_bucket=int(samples_per_bucket),
        source_channels=int(channels),
        duration_seconds=frames / float(sample_rate) if sample_rate else 0.0,
        minima=minima,
        maxima=maxima,
    )


def encode_peaks(peaks: PeakData) -> bytes:
    """Serialise a :class:`PeakData` to the ``.speaks`` binary layout."""
    header = struct.pack(
        "<5sBHIIIId",
        MAGIC,
        VERSION,
        0,
        peaks.sample_rate,
        peaks.samples_per_bucket,
        peaks.bucket_count,
        peaks.source_channels,
        peaks.duration_seconds,
    )
    assert len(header) == HEADER_SIZE, f"header is {len(header)} bytes, expected 32"

    interleaved = np.empty(peaks.bucket_count * 2, dtype=np.int16)
    interleaved[0::2] = _to_int16(peaks.minima)
    interleaved[1::2] = _to_int16(peaks.maxima)
    return header + interleaved.astype("<i2", copy=False).tobytes()


def decode_peaks(payload: bytes) -> PeakData:
    """Inverse of :func:`encode_peaks`. Used by tests and by the CLI."""
    if len(payload) < HEADER_SIZE:
        raise SipraError(ErrorCode.INTERNAL, "Peak payload is shorter than its header")

    magic, version, _reserved, sr, spb, count, channels, duration = struct.unpack(
        "<5sBHIIIId", payload[:HEADER_SIZE]
    )
    if magic != MAGIC:
        raise SipraError(ErrorCode.INTERNAL, "Not a Sipra peak file")
    if version != VERSION:
        raise SipraError(
            ErrorCode.INTERNAL, f"Unsupported peak file version {version}"
        )

    expected = count * 2 * 2
    body = payload[HEADER_SIZE : HEADER_SIZE + expected]
    if len(body) != expected:
        raise SipraError(ErrorCode.INTERNAL, "Peak payload is truncated")

    interleaved = np.frombuffer(body, dtype="<i2")
    return PeakData(
        sample_rate=int(sr),
        samples_per_bucket=int(spb),
        source_channels=int(channels),
        duration_seconds=float(duration),
        minima=(interleaved[0::2].astype(np.float32) / INT16_SCALE),
        maxima=(interleaved[1::2].astype(np.float32) / INT16_SCALE),
    )


def write_peaks(path: str | Path, peaks: PeakData) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(encode_peaks(peaks))
    return p


def _to_int16(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -1.0, 1.0)
    return np.rint(clipped * INT16_SCALE).astype(np.int16)
