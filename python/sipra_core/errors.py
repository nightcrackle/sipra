"""Error types shared across the Sipra core.

Every failure that crosses the process boundary is normalised into a
:class:`SipraError` so the Electron side always receives a stable
``{code, message, details}`` shape instead of a Python traceback.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class ErrorCode:
    """Stable, machine-readable error codes.

    These strings are part of the sidecar contract. Renaming one is a
    breaking change; add a new code instead.
    """

    BAD_REQUEST = "BAD_REQUEST"
    UNKNOWN_METHOD = "UNKNOWN_METHOD"
    INVALID_PARAMS = "INVALID_PARAMS"
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
    DECODE_FAILED = "DECODE_FAILED"
    ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
    SEPARATION_FAILED = "SEPARATION_FAILED"
    ANALYSIS_FAILED = "ANALYSIS_FAILED"
    CANCELLED = "CANCELLED"
    DOWNLOADER_UNAVAILABLE = "DOWNLOADER_UNAVAILABLE"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    RIGHTS_NOT_CONFIRMED = "RIGHTS_NOT_CONFIRMED"
    UNSUPPORTED_URL = "UNSUPPORTED_URL"
    INTERNAL = "INTERNAL"


class SipraError(Exception):
    """An error with a stable code that is safe to send to the UI."""

    def __init__(
        self,
        code: str,
        message: str,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: dict[str, Any] = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            payload["details"] = self.details
        return payload

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"SipraError(code={self.code!r}, message={self.message!r})"


class CancelledError(SipraError):
    """Raised when a job is cancelled cooperatively."""

    def __init__(self, message: str = "Job cancelled") -> None:
        super().__init__(ErrorCode.CANCELLED, message)
