"""Local file ingest: validation and import into the workspace."""

from __future__ import annotations

import hashlib
import re
import shutil
import unicodedata
from pathlib import Path

from ..audio_io import MAX_INPUT_BYTES, SUPPORTED_INPUT_EXTENSIONS, probe
from ..errors import ErrorCode, SipraError

# Characters Windows forbids in filenames, plus control characters.
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Windows refuses these names regardless of extension.
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

MAX_STEM_NAME_LENGTH = 96


def safe_filename(name: str, fallback: str = "track") -> str:
    """Turn arbitrary text into a filename that is safe on Windows.

    Handles the cases that actually bite: reserved device names, trailing
    dots and spaces (which Windows silently strips, producing collisions),
    path separators smuggled in through metadata, and over-long names.
    """
    normalised = unicodedata.normalize("NFKC", str(name or "")).strip()
    cleaned = _ILLEGAL.sub("_", normalised)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")

    if not cleaned:
        return fallback
    # A name made only of substitutions ("///" -> "___") carries no
    # information. A name made of other punctuation ("!!!") is a real
    # title and is kept.
    if set(cleaned) <= {"_"}:
        return fallback
    if cleaned.split(".")[0].upper() in _RESERVED:
        cleaned = f"_{cleaned}"
    if len(cleaned) > MAX_STEM_NAME_LENGTH:
        cleaned = cleaned[:MAX_STEM_NAME_LENGTH].rstrip(" .")
    return cleaned or fallback


def unique_path(directory: str | Path, filename: str) -> Path:
    """Return a path inside ``directory`` that does not already exist."""
    base = Path(directory)
    candidate = base / filename
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    for counter in range(2, 1000):
        candidate = base / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate
    # Astronomically unlikely; fall back to a content-free unique suffix.
    return base / f"{stem} ({hashlib.sha1(stem.encode()).hexdigest()[:8]}){suffix}"


def validate_input(path: str | Path) -> dict:
    """Check that ``path`` is an audio file Sipra is willing to open."""
    p = Path(path)
    if not p.exists():
        raise SipraError(ErrorCode.FILE_NOT_FOUND, f"No such file: {p}", {"path": str(p)})
    if not p.is_file():
        raise SipraError(
            ErrorCode.UNSUPPORTED_FORMAT, f"Not a file: {p}", {"path": str(p)}
        )

    extension = p.suffix.lower()
    if extension not in SUPPORTED_INPUT_EXTENSIONS:
        raise SipraError(
            ErrorCode.UNSUPPORTED_FORMAT,
            f"Sipra does not open {extension or 'files without an extension'}",
            {"path": str(p), "supported": list(SUPPORTED_INPUT_EXTENSIONS)},
        )

    size = p.stat().st_size
    if size == 0:
        raise SipraError(ErrorCode.DECODE_FAILED, "File is empty", {"path": str(p)})
    if size > MAX_INPUT_BYTES:
        raise SipraError(
            ErrorCode.UNSUPPORTED_FORMAT,
            "File is larger than the 2 GB limit",
            {"path": str(p), "sizeBytes": size},
        )

    return probe(p)


def import_file(path: str | Path, destination_dir: str | Path) -> Path:
    """Copy a validated audio file into the workspace.

    A copy is taken deliberately: the library must keep working after the
    user moves, renames or deletes the original, and separation output
    lives beside the imported copy.
    """
    source = Path(path)
    validate_input(source)

    dest_dir = Path(destination_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = unique_path(dest_dir, safe_filename(source.name, "track" + source.suffix))

    try:
        shutil.copy2(source, target)
    except OSError as exc:
        raise SipraError(
            ErrorCode.INTERNAL,
            f"Could not copy the file into the library: {exc}",
            {"source": str(source), "target": str(target)},
        ) from exc
    return target


def file_fingerprint(path: str | Path, chunk_bytes: int = 1024 * 1024) -> str:
    """Content hash used to spot re-imports of the same audio.

    Hashes the head, the tail and the size rather than the whole file: a
    full hash of a 200 MB WAV is slow enough to be noticeable on drop, and
    this is only ever used to ask "have you already imported this?".
    """
    p = Path(path)
    size = p.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    with p.open("rb") as handle:
        digest.update(handle.read(chunk_bytes))
        if size > chunk_bytes * 2:
            handle.seek(-chunk_bytes, 2)
            digest.update(handle.read(chunk_bytes))
    return digest.hexdigest()
