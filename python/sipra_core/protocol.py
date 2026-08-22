"""NDJSON request/response protocol spoken between Electron and this sidecar.

The framing is deliberately boring: one compact JSON object per line on
stdout, one per line on stdin. Anything the underlying libraries print is
redirected to stderr so a stray ``print`` from a dependency can never
corrupt the stream.

Message shapes
--------------
Request   ``{"id": "1", "method": "analyze", "params": {...}}``
Response  ``{"id": "1", "ok": true, "result": {...}}``
Error     ``{"id": "1", "ok": false, "error": {"code": "...", "message": "..."}}``
Event     ``{"event": "progress", "id": "1", "data": {...}}``

Events are unsolicited and may arrive at any point between a request and
its response. ``id`` on an event correlates it with the originating
request; events with no ``id`` are process-level notices.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from .errors import ErrorCode, SipraError

PROTOCOL_VERSION = 1

# Guard against a pathological line (e.g. a binary file accidentally piped
# into stdin) consuming unbounded memory.
MAX_LINE_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class Request:
    """A decoded inbound request."""

    id: str
    method: str
    params: dict[str, Any] = field(default_factory=dict)


def decode_request(line: str) -> Request:
    """Parse one NDJSON line into a :class:`Request`.

    Raises:
        SipraError: if the line is not a JSON object with a usable
            ``id`` and ``method``.
    """
    stripped = line.strip()
    if not stripped:
        raise SipraError(ErrorCode.BAD_REQUEST, "Empty request line")
    if len(stripped.encode("utf-8")) > MAX_LINE_BYTES:
        raise SipraError(ErrorCode.BAD_REQUEST, "Request line exceeds size limit")

    try:
        raw = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise SipraError(
            ErrorCode.BAD_REQUEST, f"Malformed JSON: {exc.msg}", {"pos": exc.pos}
        ) from exc

    if not isinstance(raw, dict):
        raise SipraError(ErrorCode.BAD_REQUEST, "Request must be a JSON object")

    req_id = raw.get("id")
    if not isinstance(req_id, str) or not req_id:
        raise SipraError(ErrorCode.BAD_REQUEST, "Request 'id' must be a non-empty string")

    method = raw.get("method")
    if not isinstance(method, str) or not method:
        raise SipraError(
            ErrorCode.BAD_REQUEST, "Request 'method' must be a non-empty string"
        )

    params = raw.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise SipraError(ErrorCode.BAD_REQUEST, "Request 'params' must be an object")

    return Request(id=req_id, method=method, params=params)


def _dumps(payload: Mapping[str, Any]) -> str:
    """Serialise to a single compact line with no embedded newlines."""
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str)


def encode_response(req_id: str, result: Any) -> str:
    return _dumps({"id": req_id, "ok": True, "result": result})


def encode_error(req_id: str | None, error: SipraError) -> str:
    payload: dict[str, Any] = {"ok": False, "error": error.to_dict()}
    if req_id is not None:
        payload["id"] = req_id
    return _dumps(payload)


def encode_event(event: str, data: Any, req_id: str | None = None) -> str:
    payload: dict[str, Any] = {"event": event, "data": data}
    if req_id is not None:
        payload["id"] = req_id
    return _dumps(payload)


def require(params: Mapping[str, Any], name: str, kind: type | tuple[type, ...]) -> Any:
    """Fetch a required parameter, or raise ``INVALID_PARAMS``."""
    if name not in params:
        raise SipraError(ErrorCode.INVALID_PARAMS, f"Missing required parameter '{name}'")

    value = params[name]
    accepted: tuple[type, ...] = kind if isinstance(kind, tuple) else (kind,)

    # `bool` is a subclass of `int`, so a plain isinstance check would let
    # {"shifts": true} through as shifts=1. Reject booleans unless the
    # caller actually asked for one.
    bool_smuggled_in = isinstance(value, bool) and bool not in accepted

    if bool_smuggled_in or not isinstance(value, accepted):
        raise SipraError(
            ErrorCode.INVALID_PARAMS,
            f"Parameter '{name}' must be of type {_type_name(kind)}",
        )
    return value


def optional(
    params: Mapping[str, Any],
    name: str,
    kind: type | tuple[type, ...],
    default: Any = None,
) -> Any:
    """Fetch an optional parameter, validating its type when present."""
    if name not in params or params[name] is None:
        return default
    return require(params, name, kind)


def _type_name(kind: type | tuple[type, ...]) -> str:
    if isinstance(kind, tuple):
        return " or ".join(k.__name__ for k in kind)
    return kind.__name__
