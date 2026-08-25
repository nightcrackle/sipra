"""Audio loading and writing.

Decoding strategy
-----------------
Where ffmpeg is available it does the decoding, in a child process, and
``libsndfile`` is the fallback. That ordering is about what can be
stopped rather than about audio quality — libsndfile reads WAV, FLAC and
Ogg perfectly well, but it reads them *inside this process*, and a native
read that stalls cannot be timed out, cancelled or killed. It stalls the
only worker there is for as long as the application stays open.

A child process can be given a deadline, watched for having gone quiet,
and killed. A real import stopped most of the way through a freshly
downloaded file and sat there for eight minutes, on the in-process path,
with nothing able to end it.

ffmpeg also resamples while it streams, so a file that needs a rate change
never has to be held twice.

Audio is represented throughout the core as ``float32`` in shape
``(channels, samples)`` — the same layout Demucs expects, which avoids a
transpose in the hot path.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
import soundfile as sf

from .errors import CancelledError, ErrorCode, SipraError
from .trace import Throttle, trace


class Cancellable(Protocol):
    """Just the part of a cancellation token this module needs."""

    @property
    def cancelled(self) -> bool: ...


#: Frames read per block from libsndfile. About four megabytes of stereo
#: float, so progress moves several times a second on a long track without
#: the read loop itself costing anything measurable.
DECODE_BLOCK_FRAMES = 1 << 19

#: Bytes read per chunk from a decoder's stdout.
DECODE_CHUNK_BYTES = 1 << 20

#: Ceiling on decoding one file. Generous — an hour of audio on a slow disk
#: is minutes of honest work — but finite, which is the point. A decoder
#: that stops responding used to stop the job with it until the app was
#: closed.
DECODE_TIMEOUT_SECONDS = 900

#: Ceiling on the metadata probe. It reads a header.
FFPROBE_TIMEOUT_SECONDS = 30

#: How often a running decoder is checked for cancellation and for its
#: deadline. Short enough that Cancel feels immediate.
DECODE_POLL_SECONDS = 0.25

#: How long a decoder may produce nothing at all before it is given up on.
#:
#: The wall-clock ceiling above is generous because a legitimately long
#: decode is legitimately long. This is the other question, and the more
#: useful one: a decoder that has stopped producing output has stopped,
#: whatever its total budget says. Waiting out fifteen minutes to find that
#: out helps nobody.
DECODE_STALL_SECONDS = 120

#: How often a decoder in progress says so, in seconds. Turns "it stopped
#: somewhere in decoding" into a line naming how far it got.
DECODE_HEARTBEAT_SECONDS = 5.0

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
    # Containers a URL download can arrive in.
    #
    # Sipra used to force every download to WAV, so only the formats a
    # person would drop in by hand needed listing. Now the audio is kept as
    # it comes, and YouTube's best audio stream is very often Opus inside
    # WebM — which the decoder reads perfectly well and the extension check
    # was refusing outright.
    ".webm",
    ".mp4",
    ".m4b",
    ".mka",
    ".mkv",
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
    on_progress: Callable[[float], None] | None = None,
    token: Cancellable | None = None,
) -> AudioBuffer:
    """Decode ``path`` into a float32 :class:`AudioBuffer`.

    Args:
        path: File to decode.
        target_sample_rate: Decode to this rate. Handed to ffmpeg where
            ffmpeg does the decoding, so the conversion happens while
            streaming rather than over a fully resident copy.
        mono: Average all channels down to one.
        on_progress: Called with 0-1 across any rate conversion that has to
            happen in memory. A conversion that reports nothing is
            indistinguishable from one that has stopped.
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

    # Decoding reports across the first half of whatever the caller gave
    # it, leaving the second half for a rate conversion if one is needed.
    # Before this, a decode of a large file was a single opaque call: a job
    # that stopped inside it left a log whose last line was "decoding
    # <name>" and nothing after it, which is exactly as much help as no log
    # at all.
    def _decoding(fraction: float) -> None:
        if on_progress:
            on_progress(0.5 * min(1.0, max(0.0, fraction)))

    trace("decoder starting", file=p.name, sizeMb=round(size / 1024 / 1024, 1))
    data, sr = _decode(p, target_sample_rate, _decoding, token)

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
        # Only reachable via libsndfile — the ffmpeg path was given the
        # target rate and already produced it.
        buf = resample(
            buf,
            target_sample_rate,
            on_progress=lambda f: on_progress(0.5 + 0.5 * f) if on_progress else None,
        )
    elif on_progress:
        on_progress(1.0)
    return buf


def prefer_subprocess_decoder() -> bool:
    """Whether to decode in a child process rather than in this one.

    True when ffmpeg is available, unless overridden.

    This is not about which decoder is better at reading audio — libsndfile
    is perfectly good. It is about what can be stopped. A read inside this
    process is a native call: it cannot be timed out, cannot be cancelled,
    and cannot be killed. A read that stalls there stalls the only worker
    there is, for as long as the application stays open, and no amount of
    supervision above it can help.

    A child process can be given a deadline, watched for having gone quiet,
    and killed. That is the whole argument. A real import stopped seventy
    to a hundred per cent of the way through a freshly downloaded file and
    sat there for eight minutes — on the one decode path with no way to
    end it. The same file decoded without complaint on the next attempt,
    which is what a bounded, retryable decode gives you for free.

    Set ``SIPRA_DECODER=libsndfile`` to force the in-process path back.
    """
    choice = os.environ.get("SIPRA_DECODER", "").strip().lower()
    if choice == "libsndfile":
        return False
    if choice == "ffmpeg":
        return True
    return ffmpeg_path() is not None


def _decode(
    path: Path,
    target_sample_rate: int | None,
    on_progress: Callable[[float], None] | None,
    token: Cancellable | None,
) -> tuple[np.ndarray, int]:
    """Decode with the preferred reader, falling back to the other one."""
    if prefer_subprocess_decoder():
        first, second = _load_with_ffmpeg, _load_with_soundfile
        names = ("ffmpeg", "libsndfile")
    else:
        first, second = _load_with_soundfile, _load_with_ffmpeg
        names = ("libsndfile", "ffmpeg")

    try:
        data, sr = first(path, target_sample_rate, on_progress=on_progress, token=token)
        trace(f"decoded with {names[0]}", rate=sr, frames=int(data.shape[1]))
        return data, sr
    except CancelledError:
        raise
    except Exception as primary:
        # A stall or a deadline is a fact about this file, not a reason to
        # try the reader that cannot be stopped. Only a refusal to open the
        # format is worth a second attempt.
        if isinstance(primary, SipraError) and primary.code != ErrorCode.DECODE_FAILED:
            raise
        trace(f"{names[0]} could not read it, trying {names[1]}", reason=str(primary)[:140])

    try:
        data, sr = second(path, target_sample_rate, on_progress=on_progress, token=token)
        trace(f"decoded with {names[1]}", rate=sr, frames=int(data.shape[1]))
        return data, sr
    except (SipraError, CancelledError):
        raise
    except Exception as secondary:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            f"Could not decode {path.name}",
            {names[1]: str(secondary)},
        ) from secondary


def _load_with_soundfile(
    path: Path,
    _target_sample_rate: int | None = None,
    *,
    on_progress: Callable[[float], None] | None = None,
    token: Cancellable | None = None,
) -> tuple[np.ndarray, int]:
    """Decode with libsndfile, a block at a time.

    Read in blocks rather than in one call so the caller can report
    progress and so a cancel is honoured partway through. A whole-file read
    of a long track is tens of seconds of nothing on a slow disk — the same
    silence as a stall, and this is the step a real job stopped in.
    """
    with sf.SoundFile(str(path)) as handle:
        channels = int(handle.channels)
        rate = int(handle.samplerate)
        frames = int(handle.frames)

        if frames <= 0:
            # A stream whose length libsndfile cannot state up front. Rare
            # for the formats it opens, but it must not become a crash.
            data = handle.read(dtype="float32", always_2d=True)
            if on_progress:
                on_progress(1.0)
            return np.ascontiguousarray(np.asarray(data, dtype=np.float32).T), rate

        # One allocation for the result; blocks are read straight into it.
        out = np.empty((frames, channels), dtype=np.float32)
        position = 0
        heartbeat = Throttle(DECODE_HEARTBEAT_SECONDS)
        while position < frames:
            if token is not None and token.cancelled:
                raise CancelledError("Decoding cancelled")
            want = min(DECODE_BLOCK_FRAMES, frames - position)
            chunk = handle.read(
                want, dtype="float32", always_2d=True, out=out[position : position + want]
            )
            got = int(np.asarray(chunk).shape[0])
            if got <= 0:
                # The header promised more than the file holds.
                out = out[:position]
                break
            position += got
            if on_progress:
                on_progress(position / frames)
            if heartbeat.ready():
                trace("libsndfile still reading", frame=position, of=frames)

    # soundfile yields (frames, channels); the core wants (channels, frames).
    return np.ascontiguousarray(out.T), rate


def _load_with_ffmpeg(
    path: Path,
    target_sample_rate: int | None = None,
    *,
    on_progress: Callable[[float], None] | None = None,
    token: Cancellable | None = None,
) -> tuple[np.ndarray, int]:
    """Decode to float32 PCM, optionally converting the rate on the way.

    Handing ffmpeg the target rate is free — it resamples while it streams,
    before any of this is resident in memory. Doing it afterwards in numpy
    means holding the whole track twice at the worst possible moment.
    """
    exe = ffmpeg_path()
    if not exe:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            "This format needs ffmpeg, which was not found on this system",
            {"path": str(path)},
        )

    meta = _ffprobe_stream(exe, path)
    sr = int(target_sample_rate) if target_sample_rate else meta["sample_rate"]
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

    # Expected output size, for progress. Wrong or missing duration only
    # costs a less accurate bar, never a wrong result.
    duration = meta.get("duration") or 0.0
    expected = int(duration * sr * channels * 4) if duration > 0 else 0

    payload, stderr = _run_streaming(
        cmd,
        expected_bytes=expected,
        timeout=DECODE_TIMEOUT_SECONDS,
        on_progress=on_progress,
        token=token,
        label="ffmpeg",
    )

    if not payload:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            "ffmpeg could not decode this file",
            {"stderr": stderr[-800:]},
        )

    flat = np.frombuffer(payload, dtype="<f4")
    usable = (flat.size // channels) * channels
    interleaved = flat[:usable].reshape(-1, channels)
    return np.ascontiguousarray(interleaved.T.astype(np.float32)), sr


def _run_streaming(
    cmd: list[str],
    expected_bytes: int,
    timeout: float,
    on_progress: Callable[[float], None] | None,
    token: Cancellable | None,
    label: str,
) -> tuple[bytes, str]:
    """Run a command, reading stdout in chunks against a deadline.

    Three things this does that ``subprocess.run`` cannot:

    * **It ends.** ``subprocess.run`` here carried no timeout at all, so a
      decoder that stopped responding stopped the job with it, for as long
      as the app stayed open. That is the same defect that was fixed in the
      downloader and left in place here.
    * **It reports.** Decoding a long track is tens of seconds of output
      arriving steadily; a bar that does not move through it is
      indistinguishable from one that has stopped.
    * **It can be cancelled.** The check happens between chunks, so Cancel
      works during a decode instead of waiting it out.

    stderr is drained on its own thread for the reason it always is: a
    child blocked writing to a full stderr pipe while the parent blocks
    reading stdout is a deadlock that no timeout on ``wait`` can reach.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        # Never inherit the sidecar's stdin; see ingest/youtube.py.
        stdin=subprocess.DEVNULL,
        creationflags=_creation_flags(),
    )

    errors: list[bytes] = []

    def _drain() -> None:
        if proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                errors.append(line)
                if len(errors) > 200:
                    del errors[:100]
        except Exception:  # pragma: no cover - stream closed under us
            pass

    drain = threading.Thread(target=_drain, name=f"{label}-stderr", daemon=True)
    drain.start()

    chunks: list[bytes] = []
    counter = {"read": 0}
    # Written by the pump, read by the poll loop. A plain float assignment
    # is atomic enough for a liveness check.
    last_byte_at = {"when": time.monotonic()}
    pump_error: list[BaseException] = []

    # stdout is read on its own thread as well.
    #
    # `read()` blocks until it has a full chunk or the pipe closes. A
    # deadline checked around that read is not a deadline: a child that
    # produces nothing and does not exit blocks in it forever, which is
    # precisely the failure being guarded against. The poll loop below owns
    # the clock, and it can always run.
    def _pump() -> None:
        if proc.stdout is None:
            return
        heartbeat = Throttle(DECODE_HEARTBEAT_SECONDS)
        # `read1` returns whatever has arrived, up to the limit. `read`
        # waits for the full amount, which means a decoder trickling data
        # registers as producing nothing until a whole megabyte has piled
        # up — so progress lurches, and the liveness check below would
        # eventually call a working decoder stalled.
        read_available = getattr(proc.stdout, "read1", proc.stdout.read)
        try:
            while True:
                chunk = read_available(DECODE_CHUNK_BYTES)
                if not chunk:
                    return
                chunks.append(chunk)
                counter["read"] += len(chunk)
                last_byte_at["when"] = time.monotonic()
                if on_progress and expected_bytes > 0:
                    on_progress(min(0.99, counter["read"] / expected_bytes))
                if heartbeat.ready():
                    trace(
                        f"{label} still decoding",
                        readMb=round(counter["read"] / 1024 / 1024, 1),
                        ofMb=round(expected_bytes / 1024 / 1024, 1) if expected_bytes else None,
                    )
        except BaseException as exc:  # noqa: BLE001 - recorded, then re-raised below
            # A pump that dies quietly is the worst outcome available: with
            # nothing draining stdout the decoder blocks writing, and the
            # poll loop below waits out its entire budget for a process
            # that will never finish. Recorded so the caller can say so.
            pump_error.append(exc)

    pump = threading.Thread(target=_pump, name=f"{label}-stdout", daemon=True)
    pump.start()

    deadline = time.monotonic() + timeout
    try:
        while True:
            if token is not None and token.cancelled:
                proc.kill()
                raise CancelledError(f"{label} cancelled")

            if pump_error:
                proc.kill()
                raise SipraError(
                    ErrorCode.DECODE_FAILED,
                    f"{label}'s output could not be read: {pump_error[0]}",
                    {"bytesRead": counter["read"]},
                )

            now = time.monotonic()
            silent_for = now - last_byte_at["when"]
            if silent_for > DECODE_STALL_SECONDS:
                proc.kill()
                raise SipraError(
                    ErrorCode.DECODE_FAILED,
                    f"{label} stopped producing output after "
                    f"{counter['read'] // (1024 * 1024)} MB and did not resume "
                    f"within {DECODE_STALL_SECONDS} seconds.",
                    {
                        "bytesRead": counter["read"],
                        "silentForSeconds": int(silent_for),
                        "expectedBytes": expected_bytes,
                    },
                )
            if now > deadline:
                proc.kill()
                raise SipraError(
                    ErrorCode.DECODE_FAILED,
                    f"{label} did not finish within {int(timeout)} seconds.",
                    {"timeoutSeconds": int(timeout), "bytesRead": counter["read"]},
                )
            try:
                proc.wait(timeout=DECODE_POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                continue
    except CancelledError:
        raise
    finally:
        pump.join(timeout=5)
        drain.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:  # pragma: no cover
                    pass

    if on_progress:
        on_progress(1.0)

    text = b"".join(errors).decode("utf-8", "replace")
    if proc.returncode != 0:
        raise SipraError(
            ErrorCode.DECODE_FAILED,
            f"{label} failed while decoding this file.",
            {"stderr": text[-800:], "returncode": proc.returncode},
        )
    return b"".join(chunks), text


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
    fallback = {"sample_rate": 44100, "channels": 2, "duration": 0.0}
    if not Path(probe_exe).exists() and not shutil.which(probe_exe):
        return fallback
    try:
        proc = subprocess.run(
            [
                probe_exe,
                "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=sample_rate,channels,duration",
                "-of", "csv=p=0",
                str(path),
            ],
            capture_output=True,
            check=False,
            stdin=subprocess.DEVNULL,
            # A probe that cannot answer in half a minute is not going to.
            # Without this it could hold a job open indefinitely, which is
            # the defect that was fixed in the downloader and left here.
            timeout=FFPROBE_TIMEOUT_SECONDS,
            creationflags=_creation_flags(),
        )
        parts = proc.stdout.decode("utf-8", "replace").strip().split(",")
        if len(parts) >= 3 and parts[0] and parts[1]:
            sr = int(parts[0])
            ch = int(parts[1])
            duration = _to_float(parts[2])
            if sr > 0 and 1 <= ch <= 8:
                return {"sample_rate": sr, "channels": ch, "duration": duration}
        if len(parts) >= 2 and parts[0] and parts[1]:
            sr = int(parts[0])
            ch = int(parts[1])
            if sr > 0 and 1 <= ch <= 8:
                return {"sample_rate": sr, "channels": ch, "duration": 0.0}
    except subprocess.TimeoutExpired:
        trace("ffprobe timed out; assuming CD-quality stereo", file=path.name)
    except Exception:  # pragma: no cover - defensive
        pass
    return fallback


def _to_float(text: str) -> float:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return 0.0
    return value if value > 0 else 0.0


def resample(
    buf: AudioBuffer,
    target_sample_rate: int,
    on_progress: Callable[[float], None] | None = None,
) -> AudioBuffer:
    """Band-limited resample using SciPy's polyphase filter.

    Done one channel at a time. Two reasons, both learned the hard way from
    a job that stopped at 86% with this call as the last thing it logged:
    it halves the peak allocation, which matters because this used to run
    with a whole separation's worth of stems still resident; and it gives
    the caller somewhere to report from, so a slow conversion looks slow
    rather than looking stopped.
    """
    if target_sample_rate <= 0:
        raise SipraError(ErrorCode.INVALID_PARAMS, "target_sample_rate must be positive")
    if buf.sample_rate == target_sample_rate:
        return buf

    from math import gcd

    from scipy.signal import resample_poly

    divisor = gcd(int(buf.sample_rate), int(target_sample_rate))
    up = int(target_sample_rate) // divisor
    down = int(buf.sample_rate) // divisor

    channels = buf.data.shape[0]
    trace("resampling", frm=buf.sample_rate, to=target_sample_rate, channels=channels)
    converted: list[np.ndarray] = []
    for index in range(channels):
        if on_progress:
            on_progress(index / channels)
        # np.ascontiguousarray because a channel of a transposed buffer is
        # strided, and the polyphase filter walks it sample by sample.
        channel = np.ascontiguousarray(buf.data[index])
        converted.append(resample_poly(channel, up, down).astype(np.float32, copy=False))
        trace("resampled a channel", channel=index + 1, of=channels)
    if on_progress:
        on_progress(1.0)

    out = np.ascontiguousarray(np.stack(converted, axis=0))
    return AudioBuffer(data=out, sample_rate=int(target_sample_rate))


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
