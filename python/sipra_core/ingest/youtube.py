"""URL ingest via yt-dlp.

Read this before changing anything here
---------------------------------------
Downloading from YouTube is contrary to YouTube's Terms of Service. A
checkbox in an application is not a licence and does not transfer any
right to the person clicking it. Sipra gates the feature behind an
explicit confirmation because that is honest about who is making the
decision, **not** because the confirmation makes the download lawful.

Sipra is intended for material you own, material you have written
permission to use, and material that is public domain or openly licensed.
If you are packaging or redistributing this application, read `NOTICE.md`
and decide for yourself whether to build with ``SIPRA_BUNDLE_YTDLP=0``.

Implementation notes: yt-dlp is invoked as a subprocess with an argument
list, never a shell string, and the URL is validated against a host
allowlist before it goes anywhere near the process.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from ..audio_io import SUPPORTED_INPUT_EXTENSIONS
from ..engines.base import CancellationToken
from ..errors import CancelledError, ErrorCode, SipraError
from .local import safe_filename, unique_stem

ProgressFn = Callable[[str, float], None]

# Hosts the UI offers. yt-dlp itself supports far more; Sipra deliberately
# does not, because a narrow, stated scope is easier to defend than "any
# URL you like".
ALLOWED_HOSTS: tuple[str, ...] = (
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
)

def _timeout_from_env(name: str, default: int) -> int:
    """Read a timeout override, ignoring anything unusable."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


DOWNLOAD_TIMEOUT_SECONDS = _timeout_from_env("SIPRA_YTDLP_DOWNLOAD_TIMEOUT", 20 * 60)

# How often the download is checked for cancellation and for the
# deadline. Short enough that Cancel feels immediate, long enough to
# cost nothing.
DOWNLOAD_POLL_SECONDS = 0.5

# Reading metadata is one HTTPS round trip, but the wall-clock cost is not
# that. yt-dlp for Windows is a PyInstaller single-file bundle: the first
# run unpacks ~17 MB into %TEMP% and Windows Defender scans it as it goes,
# which on a cold machine can take most of a minute on its own. 60 s was
# too tight for that and produced timeouts that looked like network
# failures. The unpack cost is now paid once in `ensure_ready`, and this
# covers the request itself with room to spare.
METADATA_TIMEOUT_SECONDS = _timeout_from_env("SIPRA_YTDLP_METADATA_TIMEOUT", 120)

# One-off cost of unpacking the bundle and starting the interpreter.
PREFLIGHT_TIMEOUT_SECONDS = _timeout_from_env("SIPRA_YTDLP_PREFLIGHT_TIMEOUT", 180)

# The diagnostic gets a much shorter ceiling than the operations it is
# diagnosing. A check that hangs for three minutes tells the user nothing
# they did not already know.
DIAGNOSE_TIMEOUT_SECONDS = _timeout_from_env("SIPRA_YTDLP_DIAGNOSE_TIMEOUT", 25)

# Bound yt-dlp's own network waits. Without these it will sit on a
# half-open socket until *our* timeout fires, which turns a routing problem
# into an opaque "timed out" with nothing in stderr to explain it.
SOCKET_TIMEOUT_SECONDS = 15
NETWORK_RETRIES = 2

# Refuse anything long enough to be a full DJ set or a re-upload of an album.
MAX_DURATION_SECONDS = 60 * 20

_PROGRESS_PATTERN = re.compile(r"\[download\]\s+([0-9.]+)%")

# Placeholder extension for the download target.
#
# The real one is decided by whatever stream yt-dlp takes, so the name is
# reserved by stem and the produced file located afterwards.
DOWNLOAD_PLACEHOLDER_SUFFIX = ".audio"

# A YouTube video id is exactly 11 characters from a fixed alphabet.
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


@dataclass(frozen=True)
class RemoteMedia:
    path: Path
    title: str
    duration_seconds: float | None
    source_url: str
    uploader: str | None = None

    def to_dict(self) -> dict:
        return {
            "path": str(self.path),
            "title": self.title,
            "durationSeconds": self.duration_seconds,
            "sourceUrl": self.source_url,
            "uploader": self.uploader,
        }


def is_supported_url(url: str) -> bool:
    """Whether ``url`` is an http(s) URL on an allowlisted host."""
    if not isinstance(url, str) or not url.strip():
        return False
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    return host in ALLOWED_HOSTS


def video_id_of(url: str) -> str | None:
    """Extract the video id from a YouTube URL, or ``None``.

    Worth doing before spawning anything. A link that was truncated on the
    way through a chat client — ``…/watch?v=`` with nothing after it — is
    not a link yt-dlp can do anything useful with, and handing it over
    produces a slow, confusing failure instead of an instant clear one.
    """
    if not isinstance(url, str):
        return None
    try:
        parsed = urlparse(url.strip())
    except ValueError:
        return None

    host = (parsed.hostname or "").lower()
    candidate: str | None = None

    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host in ALLOWED_HOSTS:
        path = parsed.path.rstrip("/")
        if path in ("/watch", "/watch/"):
            from urllib.parse import parse_qs

            values = parse_qs(parsed.query).get("v") or []
            candidate = values[0] if values else None
        elif path.startswith(("/shorts/", "/embed/", "/live/", "/v/")):
            candidate = path.split("/")[2] if len(path.split("/")) > 2 else None

    if not candidate:
        return None
    return candidate if _VIDEO_ID.match(candidate) else None


def _reject_unusable_url(url: str) -> None:
    """Raise a specific error for a URL that cannot possibly work."""
    if not is_supported_url(url):
        raise SipraError(
            ErrorCode.UNSUPPORTED_URL,
            "Sipra only accepts YouTube links, and the link needs to start with https://.",
            {"allowedHosts": list(ALLOWED_HOSTS), "url": str(url)[:200]},
        )
    if video_id_of(url) is None:
        raise SipraError(
            ErrorCode.UNSUPPORTED_URL,
            "That link has no video in it. A YouTube link should look like "
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ — check the whole "
            "address was copied, including the part after 'v='.",
            {"url": str(url)[:200]},
        )


def ytdlp_path() -> str | None:
    """Locate yt-dlp: explicit override, bundled binary, then PATH."""
    override = os.environ.get("SIPRA_YTDLP")
    if override and Path(override).exists():
        return override

    bundled_dir = os.environ.get("SIPRA_BIN_DIR")
    if bundled_dir:
        name = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"
        candidate = Path(bundled_dir) / name
        if candidate.exists():
            return str(candidate)

    return shutil.which("yt-dlp")


def is_available() -> bool:
    return ytdlp_path() is not None


def _creation_flags() -> int:
    if sys.platform == "win32":  # pragma: no cover - platform specific
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


_READY_CACHE: dict[str, str] = {}


def _hint_lines() -> list[str]:
    """Things that actually fix a hanging yt-dlp, in rough order."""
    return [
        "Run the downloader yourself from a terminal — if it hangs there too, "
        "the problem is the binary or the machine, not Sipra.",
        "Check the machine is online and can reach youtube.com in a browser.",
        "If you are behind a proxy or VPN, yt-dlp needs it too "
        "(set HTTPS_PROXY in the environment).",
        "A half-configured IPv6 stack is a common cause of exactly this hang. "
        "Set SIPRA_YTDLP_FORCE_IPV4=1 to make yt-dlp use IPv4 only.",
        "Some antivirus products hold the first run of yt-dlp.exe for a long "
        "time while they scan it. Running it once yourself from a terminal "
        "gets that out of the way.",
    ]


def _network_args() -> list[str]:
    """Flags that stop yt-dlp waiting forever on a dead connection."""
    args = [
        # A yt-dlp.conf anywhere on the machine is read by default and can
        # contain anything, including options that make it wait. Sipra
        # needs deterministic behaviour, not the user's shell defaults.
        "--ignore-config",
        "--socket-timeout", str(SOCKET_TIMEOUT_SECONDS),
        "--retries", str(NETWORK_RETRIES),
        "--no-color",
    ]
    if os.environ.get("SIPRA_YTDLP_FORCE_IPV4") == "1":
        args.append("-4")
    return args


def _run_ytdlp(
    exe: str, args: list[str], timeout: int, doing: str
) -> subprocess.CompletedProcess:
    """Run yt-dlp, converting process-level failures into ``SipraError``.

    Without this, a ``TimeoutExpired`` propagates as an unhandled exception
    and reaches the user as "Unexpected failure: Command [...] timed out",
    which tells them nothing they can act on.
    """
    try:
        return subprocess.run(
            [exe, *args],
            capture_output=True,
            check=False,
            timeout=timeout,
            # Never let a child inherit our stdin. Ours is the NDJSON pipe
            # from Electron: a child that reads it steals protocol bytes,
            # and a child that blocks on it waits forever for input that is
            # never coming. yt-dlp spawns ffmpeg, which reads stdin for
            # keyboard commands unless told not to, so this inheritance
            # reaches two processes deep.
            stdin=subprocess.DEVNULL,
            creationflags=_creation_flags(),
        )
    except subprocess.TimeoutExpired as exc:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            f"yt-dlp did not respond within {timeout} seconds while {doing}.",
            {
                "timeoutSeconds": timeout,
                "doing": doing,
                "hints": _hint_lines(),
                "stderr": _decode(exc.stderr)[-600:],
            },
        ) from exc
    except OSError as exc:
        raise SipraError(
            ErrorCode.DOWNLOADER_UNAVAILABLE,
            f"Sipra could not start yt-dlp: {exc}",
            {"path": exe},
        ) from exc


def _decode(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    return raw.decode("utf-8", "replace")


def ensure_ready() -> str:
    """Confirm yt-dlp starts, and report its version.

    Run once and cached. On Windows the packaged yt-dlp is a PyInstaller
    single-file bundle that unpacks itself into %TEMP% the first time it
    runs, which can take a long while on a cold machine with an antivirus
    watching. Paying that here means the first real request is not the one
    that appears to hang.
    """
    exe = _require_ytdlp()
    cached = _READY_CACHE.get(exe)
    if cached is not None:
        return cached

    proc = _run_ytdlp(
        exe, ["--ignore-config", "--version"], PREFLIGHT_TIMEOUT_SECONDS, "starting up"
    )
    if proc.returncode != 0:
        raise SipraError(
            ErrorCode.DOWNLOADER_UNAVAILABLE,
            "yt-dlp is present but would not run.",
            {"path": exe, "stderr": _decode(proc.stderr)[-600:]},
        )

    version = _decode(proc.stdout).strip().splitlines()[0] if proc.stdout else "unknown"
    _READY_CACHE[exe] = version
    return version


def reset_ready_cache() -> None:
    """Forget the cached preflight result. Used by tests."""
    _READY_CACHE.clear()


def diagnose() -> dict:
    """A plain report of what is and is not working, for the UI.

    Exists because "it timed out" is not something a user can act on, and
    the difference between "no binary", "binary will not start" and
    "cannot reach YouTube" needs three different responses.
    """
    exe = ytdlp_path()
    report: dict = {
        "available": exe is not None,
        "path": exe,
        "version": None,
        "canReachYoutube": None,
        "error": None,
        "hints": [],
        "forcedIpv4": os.environ.get("SIPRA_YTDLP_FORCE_IPV4") == "1",
        "timeouts": {
            "diagnoseSeconds": DIAGNOSE_TIMEOUT_SECONDS,
            "preflightSeconds": PREFLIGHT_TIMEOUT_SECONDS,
            "metadataSeconds": METADATA_TIMEOUT_SECONDS,
            "downloadSeconds": DOWNLOAD_TIMEOUT_SECONDS,
        },
    }
    if exe is None:
        report["error"] = "yt-dlp is not available in this build of Sipra."
        return report

    # Probe directly rather than through `ensure_ready`, so the check
    # answers quickly even when the thing being checked is what hangs.
    try:
        proc = _run_ytdlp(
            exe, ["--ignore-config", "--version"], DIAGNOSE_TIMEOUT_SECONDS, "starting up"
        )
        if proc.returncode != 0:
            report["error"] = (
                "yt-dlp is present but would not run. " + _decode(proc.stderr)[-400:]
            )
            report["hints"] = _hint_lines()
            return report
        report["version"] = (
            _decode(proc.stdout).strip().splitlines()[0] if proc.stdout else "unknown"
        )
    except SipraError as exc:
        report["error"] = exc.message
        report["hints"] = list(exc.details.get("hints") or _hint_lines())
        return report

    # A real request against a stable, well-known video id.
    try:
        proc = _run_ytdlp(
            exe,
            [*_network_args(), "--no-playlist", "--skip-download", "--print", "id",
             "--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
            DIAGNOSE_TIMEOUT_SECONDS,
            "checking the connection to YouTube",
        )
        report["canReachYoutube"] = proc.returncode == 0
        if proc.returncode != 0:
            report["error"] = _decode(proc.stderr)[-600:]
            report["hints"] = _hint_lines()
    except SipraError as exc:
        report["canReachYoutube"] = False
        report["error"] = exc.message
        report["hints"] = list(exc.details.get("hints") or _hint_lines())

    return report


def _require_ytdlp() -> str:
    exe = ytdlp_path()
    if not exe:
        raise SipraError(
            ErrorCode.DOWNLOADER_UNAVAILABLE,
            "yt-dlp is not available in this build of Sipra.",
            {"hint": "Install yt-dlp and make sure it is on your PATH."},
        )
    return exe


def fetch_metadata(url: str) -> dict:
    """Read title/duration without downloading the media."""
    _reject_unusable_url(url)
    exe = _require_ytdlp()
    ensure_ready()

    proc = _run_ytdlp(
        exe,
        [*_network_args(), "--no-playlist", "--skip-download", "--dump-single-json",
         "--", url],
        METADATA_TIMEOUT_SECONDS,
        "reading that link",
    )
    if proc.returncode != 0:
        stderr = _decode(proc.stderr)
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            _explain_ytdlp_failure(stderr),
            {"stderr": stderr[-600:]},
        )
    try:
        info = json.loads(_decode(proc.stdout))
    except json.JSONDecodeError as exc:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "yt-dlp returned something Sipra could not read.",
            {"stdout": _decode(proc.stdout)[:400]},
        ) from exc

    return {
        "title": info.get("title") or "Untitled",
        "durationSeconds": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"),
        "sourceUrl": info.get("webpage_url") or url,
    }


def _explain_ytdlp_failure(stderr: str) -> str:
    """Turn yt-dlp's stderr into something a musician can act on."""
    text = stderr.lower()
    if "private video" in text:
        return "That video is private."
    if "video unavailable" in text or "not available" in text:
        return "That video is unavailable — it may have been removed or be region-locked."
    if "confirm your age" in text or "age-restricted" in text:
        return "That video is age-restricted, so yt-dlp cannot read it without signing in."
    if "sign in to confirm" in text or "not a bot" in text:
        return (
            "YouTube asked yt-dlp to prove it is not a bot. This usually clears on its "
            "own; updating yt-dlp often helps too."
        )
    if "unable to download webpage" in text or "getaddrinfo" in text or "resolve" in text:
        return "Could not reach YouTube. Check the machine is online."
    if "http error 429" in text or "too many requests" in text:
        return "YouTube is rate-limiting this machine. Wait a few minutes and try again."
    if "unsupported url" in text:
        return "yt-dlp did not recognise that link."
    return "Could not read that link. The details below are from yt-dlp."


def download_audio(
    url: str,
    destination_dir: str | Path,
    rights_confirmed: bool,
    on_progress: ProgressFn | None = None,
    token: CancellationToken | None = None,
) -> RemoteMedia:
    """Download the audio track of ``url`` into ``destination_dir``.

    Args:
        rights_confirmed: Must be ``True``. The caller is asserting that
            the user has confirmed they hold the rights to use this audio.
            See the module docstring on what that does and does not mean.
    """
    if not rights_confirmed:
        raise SipraError(
            ErrorCode.RIGHTS_NOT_CONFIRMED,
            "Confirm you have the right to use this audio before downloading it.",
        )
    _reject_unusable_url(url)

    def report(stage: str, fraction: float) -> None:
        if on_progress is not None:
            try:
                on_progress(stage, fraction)
            except Exception:  # pragma: no cover - progress must not fail a job
                pass

    # Everything before the transfer starts is silent otherwise, and on a
    # first run that silence can last minutes: the preflight unpacks the
    # yt-dlp bundle and the metadata call is a second round trip. A job
    # sitting at 0% with no stage name reads as hung.
    exe = _require_ytdlp()
    report("prepare", 0.02)
    ensure_ready()

    dest = Path(destination_dir)
    dest.mkdir(parents=True, exist_ok=True)

    report("metadata", 0.06)
    meta = fetch_metadata(url)
    report("metadata", 0.1)
    duration = meta.get("durationSeconds")
    if isinstance(duration, (int, float)) and duration > MAX_DURATION_SECONDS:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "That recording is longer than the 20 minute limit.",
            {"durationSeconds": duration},
        )

    title = safe_filename(meta.get("title") or "youtube-audio", "youtube-audio")
    target = unique_stem(dest, title, DOWNLOAD_PLACEHOLDER_SUFFIX)

    cmd = [
        exe,
        *_network_args(),
        "--no-playlist",
        "--no-continue",
        "--no-part",
        "--newline",
        # Take the audio stream as it comes.
        #
        # This used to ask for `--audio-format wav`, which makes yt-dlp run
        # a second full ffmpeg pass to expand a few megabytes of compressed
        # audio into a few hundred megabytes of PCM — a file Sipra then
        # decodes and deletes. Every byte of that was wasted: the decoder
        # reads m4a and opus perfectly well, and the download that appeared
        # to stall while "Reading the file" was reading the product of that
        # conversion.
        "--extract-audio",
        "--audio-quality", "0",
        "--output", str(target.with_suffix(".%(ext)s")),
        "--",
        url,
    ]
    ffmpeg_dir = os.environ.get("SIPRA_BIN_DIR")
    if ffmpeg_dir:
        cmd[1:1] = ["--ffmpeg-location", ffmpeg_dir]

    report("download", 0.0)
    stderr_lines: list[str] = []
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_creation_flags(),
    )

    # Drain stderr on its own thread.
    #
    # Reading stdout to EOF while stderr is an unread pipe is a deadlock
    # waiting to happen: once yt-dlp has written a pipe buffer's worth of
    # warnings (~64 KB) it blocks, and it blocks while we are blocked
    # reading stdout. Nothing times out, because the wait() that carries
    # the timeout is never reached. yt-dlp is chatty enough on stderr for
    # this to be reachable rather than theoretical.
    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                stderr_lines.append(line.rstrip())
                if len(stderr_lines) > 200:
                    del stderr_lines[:100]
        except Exception:  # pragma: no cover - stream closed under us
            pass

    # stdout is drained on its own thread as well.
    #
    # Reading it inline meant the deadline lived on the `wait()` after the
    # loop, and the loop only ends when yt-dlp closes stdout. A process
    # that goes quiet without exiting — a stalled connection, a paused
    # transfer — blocks in the read forever and never reaches the timeout
    # that was supposed to catch exactly that. The same shape holds for
    # cancellation: with the read inline, Cancel was only noticed when the
    # next line happened to arrive.
    def _drain_stdout() -> None:
        if proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                match = _PROGRESS_PATTERN.search(line)
                if match:
                    try:
                        report("download", min(float(match.group(1)) / 100.0, 0.999))
                    except ValueError:  # pragma: no cover
                        pass
        except Exception:  # pragma: no cover - stream closed under us
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, name="yt-dlp-stderr", daemon=True)
    stdout_thread = threading.Thread(target=_drain_stdout, name="yt-dlp-stdout", daemon=True)
    stderr_thread.start()
    stdout_thread.start()

    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    try:
        while True:
            if token is not None and token.cancelled:
                proc.kill()
                raise CancelledError("Download cancelled")
            if time.monotonic() > deadline:
                proc.kill()
                raise SipraError(
                    ErrorCode.DOWNLOAD_FAILED,
                    f"The download did not finish within "
                    f"{DOWNLOAD_TIMEOUT_SECONDS // 60} minutes.",
                    {"stderr": "\n".join(stderr_lines)[-600:], "hints": _hint_lines()},
                )
            try:
                proc.wait(timeout=DOWNLOAD_POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                continue
    except CancelledError:
        raise
    finally:
        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:  # pragma: no cover
                    pass

    stderr_tail = stderr_lines[-12:]

    if proc.returncode != 0:
        stderr = "\n".join(stderr_tail)
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            _explain_ytdlp_failure(stderr),
            {"stderr": stderr[-600:]},
        )

    produced = _locate_output(target)
    if produced is None:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "The download finished but no audio file was produced.",
            {"expected": str(target)},
        )

    report("download", 1.0)

    return RemoteMedia(
        path=produced,
        title=meta.get("title") or produced.stem,
        duration_seconds=duration if isinstance(duration, (int, float)) else None,
        source_url=meta.get("sourceUrl") or url,
        uploader=meta.get("uploader"),
    )


#: Extensions that are work in progress, not a finished download.
_INCOMPLETE_SUFFIXES = frozenset({".part", ".ytdl", ".temp", ".tmp", ".download"})


def _same_stem(directory: Path, stem: str) -> list[Path]:
    """Files in ``directory`` whose stem is exactly ``stem``.

    Compared literally rather than matched with ``glob``. A YouTube title
    is user text and lands in the filename intact, and ``glob`` reads
    ``[``, ``]``, ``*`` and ``?`` as pattern syntax — so a track called
    "TEETH - Laklak [HQ AUDIO]" produced a pattern whose bracket expression
    matched a single character, found nothing, and reported a completed
    download as having produced no file. Bracketed tags are close to
    universal in YouTube titles, so this was not an edge case.
    """
    try:
        entries = list(directory.iterdir())
    except OSError:
        return []
    return [
        entry
        for entry in entries
        if entry.is_file()
        and entry.stem == stem
        and entry.suffix.lower() not in _INCOMPLETE_SUFFIXES
    ]


def _locate_output(expected: Path) -> Path | None:
    """Find what yt-dlp actually wrote.

    The extension is not known in advance: it is whichever audio stream
    yt-dlp took. So the file is found by its stem, and a known audio
    extension is preferred over anything else in case an intermediate file
    is still lying around.
    """
    if expected.exists() and expected.is_file():
        return expected

    candidates = _same_stem(expected.parent, expected.stem)
    if not candidates:
        return None

    def rank(path: Path) -> tuple[int, str]:
        known = path.suffix.lower() in SUPPORTED_INPUT_EXTENSIONS
        return (0 if known else 1, path.name)

    return sorted(candidates, key=rank)[0]
