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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from ..engines.base import CancellationToken
from ..errors import CancelledError, ErrorCode, SipraError
from .local import safe_filename, unique_path

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

DOWNLOAD_TIMEOUT_SECONDS = 20 * 60
METADATA_TIMEOUT_SECONDS = 60

# Refuse anything long enough to be a full DJ set or a re-upload of an album.
MAX_DURATION_SECONDS = 60 * 20

_PROGRESS_PATTERN = re.compile(r"\[download\]\s+([0-9.]+)%")


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
    if not is_supported_url(url):
        raise SipraError(
            ErrorCode.UNSUPPORTED_URL,
            "Sipra only accepts YouTube links.",
            {"allowedHosts": list(ALLOWED_HOSTS)},
        )
    exe = _require_ytdlp()

    proc = subprocess.run(
        [exe, "--no-playlist", "--skip-download", "--dump-single-json", "--", url],
        capture_output=True,
        check=False,
        timeout=METADATA_TIMEOUT_SECONDS,
        creationflags=_creation_flags(),
    )
    if proc.returncode != 0:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "Could not read that link.",
            {"stderr": proc.stderr.decode("utf-8", "replace")[-600:]},
        )
    try:
        info = json.loads(proc.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED, "yt-dlp returned unreadable metadata"
        ) from exc

    return {
        "title": info.get("title") or "Untitled",
        "durationSeconds": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"),
        "sourceUrl": info.get("webpage_url") or url,
    }


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
    if not is_supported_url(url):
        raise SipraError(
            ErrorCode.UNSUPPORTED_URL,
            "Sipra only accepts YouTube links.",
            {"allowedHosts": list(ALLOWED_HOSTS)},
        )

    exe = _require_ytdlp()
    dest = Path(destination_dir)
    dest.mkdir(parents=True, exist_ok=True)

    meta = fetch_metadata(url)
    duration = meta.get("durationSeconds")
    if isinstance(duration, (int, float)) and duration > MAX_DURATION_SECONDS:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "That recording is longer than the 20 minute limit.",
            {"durationSeconds": duration},
        )

    title = safe_filename(meta.get("title") or "youtube-audio", "youtube-audio")
    target = unique_path(dest, f"{title}.wav")

    cmd = [
        exe,
        "--no-playlist",
        "--no-continue",
        "--no-part",
        "--newline",
        "--no-color",
        "--extract-audio",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--output", str(target.with_suffix(".%(ext)s")),
        "--",
        url,
    ]
    ffmpeg_dir = os.environ.get("SIPRA_BIN_DIR")
    if ffmpeg_dir:
        cmd[1:1] = ["--ffmpeg-location", ffmpeg_dir]

    stderr_tail: list[str] = []
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_creation_flags(),
    )
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if token is not None and token.cancelled:
                proc.kill()
                raise CancelledError("Download cancelled")
            match = _PROGRESS_PATTERN.search(line)
            if match and on_progress:
                try:
                    on_progress("download", min(float(match.group(1)) / 100.0, 0.999))
                except ValueError:  # pragma: no cover
                    pass
        proc.wait(timeout=DOWNLOAD_TIMEOUT_SECONDS)
    except CancelledError:
        raise
    except subprocess.TimeoutExpired as exc:
        proc.kill()
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED, "The download timed out."
        ) from exc
    finally:
        if proc.stderr is not None:
            stderr_tail = proc.stderr.read().splitlines()[-12:]
            proc.stderr.close()
        if proc.stdout is not None:
            proc.stdout.close()

    if proc.returncode != 0:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "yt-dlp could not download that link.",
            {"stderr": "\n".join(stderr_tail)[-600:]},
        )

    produced = _locate_output(target)
    if produced is None:
        raise SipraError(
            ErrorCode.DOWNLOAD_FAILED,
            "The download finished but no audio file was produced.",
            {"expected": str(target)},
        )

    if on_progress:
        on_progress("download", 1.0)

    return RemoteMedia(
        path=produced,
        title=meta.get("title") or produced.stem,
        duration_seconds=duration if isinstance(duration, (int, float)) else None,
        source_url=meta.get("sourceUrl") or url,
        uploader=meta.get("uploader"),
    )


def _locate_output(expected: Path) -> Path | None:
    """Find what yt-dlp actually wrote.

    Extraction should land exactly on ``expected``, but a codec fallback
    can change the extension, so the sibling with the same stem is
    accepted too.
    """
    if expected.exists():
        return expected
    for sibling in sorted(expected.parent.glob(f"{expected.stem}.*")):
        if sibling.is_file() and sibling.suffix.lower() != ".part":
            return sibling
    return None
