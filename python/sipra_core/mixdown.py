"""Offline mix rendering.

The renderer can bounce a WAV itself with an ``OfflineAudioContext``, and
for a quick export that is the faster path. This module exists for the
cases the browser cannot cover: 24-bit and 32-bit float output, FLAC, MP3,
and rendering a mix that is longer than is comfortable to hold decoded in
the renderer's memory.

Stems are read and summed in blocks rather than loaded whole, so exporting
a six-stem mix of a long track does not need six full copies of it in RAM.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .audio_io import ffmpeg_path, peak_normalise
from .engines.base import CancellationToken
from .errors import ErrorCode, SipraError

ProgressFn = Callable[[str, float], None]

BLOCK_FRAMES = 1 << 17  # ~3 s at 44.1 kHz

WAV_SUBTYPES: dict[int, str] = {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}
FLAC_SUBTYPES: dict[int, str] = {16: "PCM_16", 24: "PCM_24"}

SUPPORTED_FORMATS: tuple[str, ...] = ("wav", "flac", "mp3")

# Guard against a request that would fill the user's disk.
MAX_OUTPUT_SECONDS = 60 * 60


def db_to_gain(db: float) -> float:
    """Decibels to a linear gain. ``-inf`` and very low values mean silence."""
    if db is None or not math.isfinite(db) or db <= -120.0:
        return 0.0
    return float(10.0 ** (db / 20.0))


def resolve_gains(tracks: Sequence[dict]) -> list[tuple[Path, float]]:
    """Apply mute/solo rules and return the stems that will actually sound.

    Solo wins over mute, matching every mixing desk ever built: if any
    track is soloed, only soloed tracks are audible, and a track that is
    both soloed and muted stays silent.
    """
    if not tracks:
        raise SipraError(ErrorCode.INVALID_PARAMS, "No stems supplied for export")

    any_solo = any(bool(t.get("solo")) for t in tracks)
    resolved: list[tuple[Path, float]] = []
    for entry in tracks:
        path = entry.get("path")
        if not path:
            raise SipraError(ErrorCode.INVALID_PARAMS, "Each stem needs a 'path'")
        audible = (bool(entry.get("solo")) if any_solo else True) and not bool(
            entry.get("muted")
        )
        if not audible:
            continue
        gain = entry.get("gain")
        if gain is None:
            gain = db_to_gain(float(entry.get("gainDb", 0.0)))
        gain = float(gain)
        if gain <= 0.0:
            continue
        resolved.append((Path(path), gain))

    if not resolved:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            "Every stem in this mix is muted, so there is nothing to export.",
        )
    return resolved


def export_mix(
    tracks: Sequence[dict],
    output_path: str | Path,
    output_format: str = "wav",
    bit_depth: int = 24,
    master_gain_db: float = 0.0,
    normalise: bool = False,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    on_progress: ProgressFn | None = None,
    token: CancellationToken | None = None,
) -> dict[str, Any]:
    """Sum the given stems into a single file."""
    output_format = (output_format or "wav").lower().lstrip(".")
    if output_format not in SUPPORTED_FORMATS:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            f"Unsupported export format '{output_format}'",
            {"supported": list(SUPPORTED_FORMATS)},
        )

    resolved = resolve_gains(tracks)
    infos = [(path, gain, _open_info(path)) for path, gain in resolved]

    sample_rates = {info.samplerate for _p, _g, info in infos}
    if len(sample_rates) > 1:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            "Stems have different sample rates and cannot be summed.",
            {"sampleRates": sorted(sample_rates)},
        )
    sample_rate = int(sample_rates.pop())
    channels = max(int(info.channels) for _p, _g, info in infos)
    total_frames = max(int(info.frames) for _p, _g, info in infos)

    start_frame = 0 if start_seconds is None else max(0, int(start_seconds * sample_rate))
    end_frame = (
        total_frames if end_seconds is None else min(total_frames, int(end_seconds * sample_rate))
    )
    if end_frame <= start_frame:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            "The selected range is empty.",
            {"startSeconds": start_seconds, "endSeconds": end_seconds},
        )
    length = end_frame - start_frame
    if length / sample_rate > MAX_OUTPUT_SECONDS:
        raise SipraError(
            ErrorCode.INVALID_PARAMS, "Export would be longer than the 60 minute limit."
        )

    master_gain = db_to_gain(master_gain_db)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    # Normalising needs the whole mix before anything is written, so it
    # takes the in-memory path. Everything else streams.
    if normalise:
        mixed = _render_to_array(
            infos, start_frame, length, channels, master_gain, on_progress, token
        )
        mixed = peak_normalise(mixed)
        peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
        clipped = False
        _write_output(target, mixed, sample_rate, output_format, bit_depth)
    else:
        peak, clipped = _render_streaming(
            infos,
            target,
            start_frame,
            length,
            channels,
            sample_rate,
            master_gain,
            output_format,
            bit_depth,
            on_progress,
            token,
        )

    if on_progress:
        on_progress("export", 1.0)

    return {
        "path": str(target),
        "format": output_format,
        "sampleRate": sample_rate,
        "channels": channels,
        "durationSeconds": round(length / sample_rate, 4),
        "peakDb": round(float(20.0 * np.log10(peak)), 3) if peak > 1e-12 else None,
        "clipped": clipped,
        "stemCount": len(resolved),
        "normalised": bool(normalise),
    }


def _open_info(path: Path):
    if not path.exists():
        raise SipraError(
            ErrorCode.FILE_NOT_FOUND, f"Missing stem: {path.name}", {"path": str(path)}
        )
    try:
        return sf.info(str(path))
    except Exception as exc:
        raise SipraError(
            ErrorCode.DECODE_FAILED, f"Could not read stem {path.name}", {"detail": str(exc)}
        ) from exc


def _read_block(
    path: Path, start: int, frames: int, channels: int
) -> np.ndarray:
    """Read ``frames`` from ``path`` at ``start``, padded and channel-matched."""
    with sf.SoundFile(str(path)) as handle:
        if start >= handle.frames:
            return np.zeros((frames, channels), dtype=np.float32)
        handle.seek(start)
        block = handle.read(frames, dtype="float32", always_2d=True)

    if block.shape[0] < frames:
        block = np.pad(block, ((0, frames - block.shape[0]), (0, 0)))
    if block.shape[1] == channels:
        return block
    if block.shape[1] == 1:
        return np.repeat(block, channels, axis=1)
    if block.shape[1] > channels:
        return block[:, :channels]
    return np.pad(block, ((0, 0), (0, channels - block.shape[1])))


def _iter_blocks(length: int) -> Iterable[tuple[int, int]]:
    offset = 0
    while offset < length:
        size = min(BLOCK_FRAMES, length - offset)
        yield offset, size
        offset += size


def _render_streaming(
    infos: list[tuple[Path, float, Any]],
    target: Path,
    start_frame: int,
    length: int,
    channels: int,
    sample_rate: int,
    master_gain: float,
    output_format: str,
    bit_depth: int,
    on_progress: ProgressFn | None,
    token: CancellationToken | None,
) -> tuple[float, bool]:
    """Sum block by block straight to disk. Returns (peak, clipped)."""
    peak = 0.0
    clipped = False

    if output_format == "mp3":
        # libsndfile's MP3 support is inconsistent across builds; render a
        # WAV next to the target and let ffmpeg encode it.
        temp = target.with_suffix(".tmp.wav")
        peak, clipped = _render_streaming(
            infos, temp, start_frame, length, channels, sample_rate,
            master_gain, "wav", 32, on_progress, token,
        )
        try:
            _encode_mp3(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return peak, clipped

    subtype = _subtype_for(output_format, bit_depth)
    integer_output = subtype.startswith("PCM")

    with sf.SoundFile(
        str(target),
        mode="w",
        samplerate=sample_rate,
        channels=channels,
        subtype=subtype,
    ) as out:
        for offset, size in _iter_blocks(length):
            if token is not None:
                token.raise_if_cancelled()
            acc = np.zeros((size, channels), dtype=np.float32)
            for path, gain, _info in infos:
                acc += _read_block(path, start_frame + offset, size, channels) * gain
            acc *= master_gain

            block_peak = float(np.max(np.abs(acc))) if acc.size else 0.0
            peak = max(peak, block_peak)
            if integer_output and block_peak > 1.0:
                clipped = True
                np.clip(acc, -1.0, 1.0, out=acc)

            out.write(acc)
            if on_progress:
                on_progress("export", min((offset + size) / length, 0.999))

    return peak, clipped


def _render_to_array(
    infos: list[tuple[Path, float, Any]],
    start_frame: int,
    length: int,
    channels: int,
    master_gain: float,
    on_progress: ProgressFn | None,
    token: CancellationToken | None,
) -> np.ndarray:
    """Sum into one ``(channels, samples)`` array."""
    acc = np.zeros((length, channels), dtype=np.float32)
    for offset, size in _iter_blocks(length):
        if token is not None:
            token.raise_if_cancelled()
        for path, gain, _info in infos:
            acc[offset : offset + size] += (
                _read_block(path, start_frame + offset, size, channels) * gain
            )
        if on_progress:
            on_progress("export", min((offset + size) / length, 0.9))
    acc *= master_gain
    return np.ascontiguousarray(acc.T)


def _write_output(
    target: Path,
    data: np.ndarray,
    sample_rate: int,
    output_format: str,
    bit_depth: int,
) -> None:
    if output_format == "mp3":
        temp = target.with_suffix(".tmp.wav")
        sf.write(str(temp), data.T, sample_rate, subtype="FLOAT")
        try:
            _encode_mp3(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        return
    sf.write(str(target), data.T, sample_rate, subtype=_subtype_for(output_format, bit_depth))


def _subtype_for(output_format: str, bit_depth: int) -> str:
    table = WAV_SUBTYPES if output_format == "wav" else FLAC_SUBTYPES
    subtype = table.get(int(bit_depth))
    if subtype is None:
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            f"{output_format.upper()} does not support {bit_depth}-bit output",
            {"supported": sorted(table)},
        )
    return subtype


def _encode_mp3(source: Path, target: Path, bitrate: str = "320k") -> None:
    exe = ffmpeg_path()
    if not exe:
        raise SipraError(
            ErrorCode.INTERNAL,
            "MP3 export needs ffmpeg, which was not found. Export WAV or FLAC instead.",
        )
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    proc = subprocess.run(
        [
            exe, "-v", "error", "-nostdin", "-y",
            "-i", str(source),
            "-codec:a", "libmp3lame",
            "-b:a", bitrate,
            str(target),
        ],
        capture_output=True,
        check=False,
        stdin=subprocess.DEVNULL,
        creationflags=flags,
    )
    if proc.returncode != 0 or not target.exists():
        raise SipraError(
            ErrorCode.INTERNAL,
            "ffmpeg could not encode the MP3.",
            {"stderr": proc.stderr.decode("utf-8", "replace")[-600:]},
        )


def export_stem_copy(source: str | Path, destination: str | Path) -> dict[str, Any]:
    """Copy a rendered stem to wherever the user asked for it."""
    src = Path(source)
    if not src.exists():
        raise SipraError(ErrorCode.FILE_NOT_FOUND, f"Missing stem: {src.name}")
    dst = Path(destination)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return {"path": str(dst), "sizeBytes": os.path.getsize(dst)}
