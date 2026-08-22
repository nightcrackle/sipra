"""Stage tracing for the sidecar.

Every line goes to stderr, which the Electron main process copies into the
diagnostic log. Stdout cannot be used: it is the NDJSON protocol channel.

Tracing is **on by default**. It was opt-in until a stalled separation was
reported from a packaged build, where the opt-in switch was off and the
stderr it would have written had nowhere to go — so the one mechanism
built to explain a stall was inert in the only place stalls were seen. It
costs a few dozen short lines per job. Set ``SIPRA_TRACE_STAGES=0`` to
silence it.

Each line carries the process uptime and the gap since the previous line.
The gap is the point: a stall is not a missing line, it is a line with a
large number in front of it.
"""

from __future__ import annotations

import os
import sys
import threading
import time

_STARTED = time.monotonic()
_lock = threading.Lock()
_last = _STARTED


def is_tracing() -> bool:
    """Whether trace lines are being written."""
    return os.environ.get("SIPRA_TRACE_STAGES", "1") != "0"


def trace(message: str, **fields: object) -> None:
    """Write one trace line, if tracing is on.

    Never raises. A diagnostic that can fail a job is worse than no
    diagnostic at all.
    """
    if not is_tracing():
        return
    try:
        global _last
        now = time.monotonic()
        with _lock:
            gap = now - _last
            _last = now
        extra = " ".join(f"{k}={v}" for k, v in fields.items() if v is not None)
        line = f"[sipra {now - _STARTED:9.3f}s +{gap:7.3f}s] {message}"
        if extra:
            line = f"{line} | {extra}"
        print(line, file=sys.stderr, flush=True)
    except Exception:  # pragma: no cover - tracing must never break a job
        pass


def memory_mb() -> tuple[int, int] | None:
    """``(available, total)`` system memory in MB, or ``None`` if unknown.

    No dependency: Windows through ``GlobalMemoryStatusEx``, Linux through
    ``/proc/meminfo``. Recorded at each stage boundary so that a job which
    slows to a stop can be checked against the machine's memory rather than
    guessed about. A pipeline stage that measures well under a second in
    testing and takes minutes on one machine is either doing more work than
    expected or running out of room, and only one of those leaves a trace.
    """
    try:
        if sys.platform == "win32":
            import ctypes

            class _Status(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = _Status()
            status.dwLength = ctypes.sizeof(_Status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return (
                int(status.ullAvailPhys // (1024 * 1024)),
                int(status.ullTotalPhys // (1024 * 1024)),
            )

        available = total = 0
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    available = int(line.split()[1]) // 1024
                elif line.startswith("MemTotal:"):
                    total = int(line.split()[1]) // 1024
                if available and total:
                    break
        return (available, total) if total else None
    except Exception:
        return None


def trace_memory(message: str) -> None:
    """Trace a line carrying the machine's free memory, if it can be read."""
    reading = memory_mb()
    if reading is None:
        trace(message)
    else:
        available, total = reading
        trace(message, freeMb=available, totalMb=total)


class Throttle:
    """Lets an event through at most once every ``interval`` seconds.

    Demucs fires its progress callback hundreds of times per track. Every
    one of them in the log would bury the signal; none of them leaves no
    way to tell "still working" from "stopped". One a few seconds answers
    the question and stays readable.
    """

    def __init__(self, interval: float = 5.0) -> None:
        self.interval = float(interval)
        self._last: float | None = None

    def ready(self, *, force: bool = False) -> bool:
        now = time.monotonic()
        if force or self._last is None or now - self._last >= self.interval:
            self._last = now
            return True
        return False

    def reset(self) -> None:
        self._last = None
