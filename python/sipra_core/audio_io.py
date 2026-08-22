"""Audio loading and writing.

Decoding strategy
-----------------
1. ``libsndfile`` (via ``soundfile``) handles WAV, FLAC, OGG, AIFF and —
   with a modern libsndfile — MP3.
2. Anything libsndfile refuses (M4A/AAC, WMA, exotic MP3s, containers with
   video streams) falls back to ``ffmpeg``, decoded to 32-bit float PCM on
   stdout so no temporary file is written.

Audio is represented throughout the core as ``float32`` in shape
``(channels, samples)`` — the same layout Demucs expects, which avoids a
transpose in the hot path.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from .errors import ErrorCode, SipraError

# Extensions we advertise in the UI's file picker.
SUPPORTED_INPUT_EXTENSIONS: tuple[str, ...] = (
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".oga",
    ".opus",
    ".m4a",
    ".aac",
    ".aiff",
    ".aif",
    ".wma",
)

# Beyond this we refuse rather than exhaust memory on a mis-drop.
MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
MAX_DURATION_SECONDS = 60 * 60  # 1 hour


@dataclass(frozen=True)
class AudioBuffer:
    """Decoded audio plus the metadata the rest of the core needs."""

    data: np.ndarray  # float32, shape (channels, samples)
    sample_rate: int

    @property
    def channels(self) -> int:
        return int(self.data.shape[0])

    @property
    def frames(self) -> int:
        return int(self.data.shape[1])

    @property
    def duration(self) -> float:
        return self.frames / float(self.sample_rate) if self.sample_rate else 0.0

    def to_mono(self) -> np.ndarray:
        """Channel-averaged mono view, ``float32`` shape ``(samples,)``."""
        if self.channels == 1:
            return self.data[0]
        return self.data.mean(axis=0, dtype=np.float32)


def ffmpeg_path() -> str | None:
    """Locate ffmpeg: explicit override first, then PATH."""
    override = os.environ.get("SIPRA_FFMPEG")
    if override and Path(override).exists():
        return override
    return shutil.which("ffmpeg")


def _creation_flags() -> int:
    """Suppress console windows when spawning helpers on Windows."""
    if sys.platform == "win32":  # pragma: no cover - platform specific
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def probe(path: str | Path) -> dict:
    """Return lightweight metadata without decoding the whole file."""
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise SipraError(ErrorCode.FILE_NOT_FOUND, f"No such file: {p}", {"path": str(p)})

    size = p.stat().st_size
    info: dict = {
        "path": str(p),
        "name": p.name,
        "extension": p.suffix.lower(),
        "sizeBytes": size,
    }
    try:
        meta = sf.info(str(p))
        info.update(
            {
                "sampleRate": int(meta.samplerate),
                "channels": int(meta.channels),
                "durationSeconds": float(meta.frames) / float(meta.samplerate)
                if meta.samplerate
                else 0.0,
                "format": meta.format,
                "subtype": meta.subtype,
            }
        )
    except Exception:
        # libsndfile could not read it; ffmpeg may still be able to.
        info.update({"sampleRate": None, "channels": None, "durationSeconds": None})
    return info


def load_audio(
    path: str | Path,
    target_sample_rate: int | None = None,
    mono: bool = False,
) -> AudioBuffer:
    """Decode ``path`` into a float32 :class:`AudioBuffer`.

    Args:
        path: File to decode.
        target_sample_rate: Resample to this rate when given.
        mono: Average all channels down to one.
    """
    p = Path(path)
    if not p.exists() or not p.is_file():
        raise SipraError(ErrorCode.FILE_NOT_FOUND, f"No such file: {p}", {"path": str(p)})

    size = p.stat().st_size
    if size == 0:
        raise SipraError(ErrorCode.DECODE_FAILED, "File is empty", {"path": str(p)})
    if size > MAX_INPUT_BYTES:
        raise SipraError(
            ErrorCode.UNSUPPORTED_FORMAT,
            "File is larger than the 2 GB limit",
            {"path": str(p), "sizeBytes": size},
        )

    try:
        data, sr = _load_with_soundfile(p)
    except SipraError:
        raise
    except Exception as sf_exc:
        try:
            data, sr = _load_with_ffmpeg(p)
        except SipraError:
            raise
        except Exception as ff_exc:  # pragma: no cover - depends on host tools
            raise SipraError(
                ErrorCode.DECODE_FAILED,
                f"Could not decode {p.name}",
                {"soundfile": str(sf_exc), "ffmpeg": str(ff_exc)},
            ) from ff_exc

    buf = AudioBuffer(data=data, sample_rate=sr)
    if buf.duration > MAX_DURATION_SECONDS:
        raise SipraError(
            ErrorCode.UNSUPPORTED_FORMAT,
            "Audio is longer than the 60 minute limit",
            {"durationSeconds": buf.duration},
        )

    if mono and buf.channels > 1:
        buf = AudioBuffer(
            data=buf.to_mono()[np.newaxis, :].astype(np.float32, copy=False),
            sample_rate=buf.sample_rate,
        )
    if target_sample_rate and target_sample_rate != buf.sample_rate:
        buf = resample(buf, target_sample_rate)
    return buf


def _load_with_soundfile(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    # soundfile yields (frames, channels); the core wants (channels, frames).
    return np.ascontiguousarray(data.T), int(sr)


def _load_with_ffmpeg(path: Path) -> tuple[np.ndarray, int]:
    exe = ffmpeg_path()
    if not exe:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            "This format needs ffmpeg, which was not found on this system",
            {"path": str(path)},
        )

    meta = _ffprobe_stream(exe, path)
    sr = meta["sample_rate"]
    channels = meta["channels"]

    cmd = [
        exe,
        "-v", "error",
        "-nostdin",
        "-i", str(path),
        "-map", "a:0",
        "-f", "f32le",
        "-acodec", "pcm_f32le",
        "-ar", str(sr),
        "-ac", str(channels),
        "-",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        check=False,
        # Never inherit the sidecar's stdin; see ingest/youtube.py.
        stdin=subprocess.DEVNULL,
        creationflags=_creation_flags(),
    )
    if proc.returncode != 0 or not proc.stdout:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            "ffmpeg could not decode this file",
            {"stderr": proc.stderr.decode("utf-8", "replace")[-800:]},
        )

    flat = np.frombuffer(proc.stdout, dtype="<f4")
    usable = (flat.size // channels) * channels
    interleaved = flat[:usable].reshape(-1, channels)
    return np.ascontiguousarray(interleaved.T.astype(np.float32)), sr


def _ffprobe_stream(ffmpeg_exe: str, path: Path) -> dict:
    """Ask ffprobe for the first audio stream's rate and channel count.

    Falls back to CD-quality stereo when ffprobe is unavailable, which is
    safe: ffmpeg will resample to whatever we request.
    """
    probe_exe = shutil.which("ffprobe") or str(
        Path(ffmpeg_exe).with_name(
            "ffprobe.exe" if sys.platform == "win32" else "ffprobe"
        )
    )
    fallback = {"sample_rate": 44100, "channels": 2}
    if not Path(probe_exe).exists() and not shutil.which(probe_exe):
        return fallback
    try:
        proc = subprocess.run(
            [
                probe_exe,
                "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate,channels",
                "-of", "csv=p=0",
                str(path),
            ],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
            creationflags=_creation_flags(),
        )
        parts = proc.stdout.decode("utf-8", "replace").strip().split(",")
        if len(parts) >= 2 and parts[0] and parts[1]:
            sr = int(parts[0])
            ch = int(parts[1])
            if sr > 0 and 1 <= ch <= 8:
                return {"sample_rate": sr, "channels": ch}
    except Exception:  # pragma: no cover - defensive
        pass
    return fallback


def resample(buf: AudioBuffer, target_sample_rate: int) -> AudioBuffer:
    """Band-limited resample using SciPy's polyphase filter."""
    if target_sample_rate <= 0:
        raise SipraError(ErrorCode.INVALID_PARAMS, "target_sample_rate must be positive")
    if buf.sample_rate == target_sample_rate:
        return buf

    from math import gcd

    from scipy.signal import resample_poly

    divisor = gcd(int(buf.sample_rate), int(target_sample_rate))
    up = int(target_sample_rate) // divisor
    down = int(buf.sample_rate) // divisor
    out = resample_poly(buf.data, up, down, axis=1).astype(np.float32, copy=False)
    return AudioBuffer(data=np.ascontiguousarray(out), sample_rate=int(target_sample_rate))


def write_audio(
    path: str | Path,
    data: np.ndarray,
    sample_rate: int,
    subtype: str = "PCM_16",
) -> Path:
    """Write ``(channels, samples)`` float audio to disk.

    Samples are hard-limited to [-1, 1] before an integer subtype is used,
    because libsndfile wraps rather than clips on overflow — which turns a
    hot stem into loud digital noise.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)

    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[np.newaxis, :]
    if arr.ndim != 2:
        raise SipraError(
            ErrorCode.INTERNAL, f"Expected 2-D audio, got shape {arr.shape}"
        )

    if subtype.startswith("PCM"):
        arr = np.clip(arr, -1.0, 1.0)

    sf.write(str(p), arr.T, int(sample_rate), subtype=subtype)
    return p


def peak_normalise(data: np.ndarray, ceiling_db: float = -0.3) -> np.ndarray:
    """Scale ``data`` down so its sample peak sits at ``ceiling_db``.

    Only ever attenuates — a quiet stem is left alone rather than boosted,
    which would change the balance the user heard while mixing.
    """
    arr = np.asarray(data, dtype=np.float32)
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak <= 0.0:
        return arr
    ceiling = float(10.0 ** (ceiling_db / 20.0))
    if peak <= ceiling:
        return arr
    return (arr * (ceiling / peak)).astype(np.float32, copy=False)


def mix_down(stems: Sequence[np.ndarray]) -> np.ndarray:
    """Sum equal-length stems into one ``(channels, samples)`` array."""
    if not stems:
        raise SipraError(ErrorCode.INVALID_PARAMS, "No stems supplied to mix")
    arrays = [np.asarray(s, dtype=np.float32) for s in stems]
    channels = max(a.shape[0] for a in arrays)
    frames = max(a.shape[1] for a in arrays)
    out = np.zeros((channels, frames), dtype=np.float32)
    for a in arrays:
        if a.shape[0] == 1 and channels > 1:
            a = np.repeat(a, channels, axis=0)
        out[: a.shape[0], : a.shape[1]] += a
    return out
