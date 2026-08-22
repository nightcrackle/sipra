"""The stdio sidecar server.

Reads NDJSON requests on stdin, writes NDJSON responses and events on
stdout. Short methods run on the reader thread; anything that can take
more than a moment runs on a single background worker, so a separation
job never blocks a ``cancel`` or a ``ping``.

Only one heavy job runs at a time on purpose. Two Demucs runs sharing one
GPU is a reliable way to produce an out-of-memory error halfway through
both of them.
"""

from __future__ import annotations

import os
import sys
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import __version__
from .analysis import analyse_file
from .audio_io import SUPPORTED_INPUT_EXTENSIONS, ffmpeg_path, load_audio, probe
from .engines.base import CancellationToken
from .engines.registry import EngineRegistry
from .errors import CancelledError, ErrorCode, SipraError
from .ingest import local as local_ingest
from .ingest import youtube
from .mixdown import export_mix
from .protocol import (
    PROTOCOL_VERSION,
    Request,
    decode_request,
    encode_error,
    encode_event,
    encode_response,
    optional,
    require,
)
from .stems import STEM_IDS
from .stems import describe as describe_stems
from .waveform import DEFAULT_SAMPLES_PER_BUCKET, compute_peaks, write_peaks

Handler = Callable[["SipraServer", Request], Any]


class _Writer:
    """Serialises every line onto stdout under one lock."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def write(self, line: str) -> None:
        with self._lock:
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (BrokenPipeError, ValueError):
                # The parent process went away. Nothing useful to do.
                pass


class SipraServer:
    """Dispatches protocol requests to the core."""

    def __init__(
        self,
        registry: EngineRegistry | None = None,
        stdout=None,
        max_workers: int = 1,
    ) -> None:
        self.registry = registry or EngineRegistry()
        self._writer = _Writer(stdout if stdout is not None else sys.stdout)
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="sipra-job"
        )
        self._tokens: dict[str, CancellationToken] = {}
        self._tokens_lock = threading.Lock()
        self._stopping = threading.Event()

    # -- outbound -------------------------------------------------------

    def emit_event(self, event: str, data: Any, req_id: str | None = None) -> None:
        self._writer.write(encode_event(event, data, req_id))

    def _progress_fn(self, req_id: str, job_id: str) -> Callable[[str, float], None]:
        def report(stage: str, fraction: float) -> None:
            self.emit_event(
                "progress",
                {"jobId": job_id, "stage": stage, "fraction": round(float(fraction), 4)},
                req_id,
            )

        return report

    # -- cancellation ---------------------------------------------------

    def _register_token(self, job_id: str) -> CancellationToken:
        token = CancellationToken()
        with self._tokens_lock:
            self._tokens[job_id] = token
        return token

    def _release_token(self, job_id: str) -> None:
        with self._tokens_lock:
            self._tokens.pop(job_id, None)

    def cancel_job(self, job_id: str) -> bool:
        with self._tokens_lock:
            token = self._tokens.get(job_id)
        if token is None:
            return False
        token.cancel()
        return True

    # -- dispatch -------------------------------------------------------

    def handle_line(self, line: str) -> None:
        try:
            request = decode_request(line)
        except SipraError as exc:
            self._writer.write(encode_error(None, exc))
            return

        handler = HANDLERS.get(request.method)
        if handler is None:
            self._writer.write(
                encode_error(
                    request.id,
                    SipraError(
                        ErrorCode.UNKNOWN_METHOD,
                        f"Unknown method '{request.method}'",
                        {"known": sorted(HANDLERS)},
                    ),
                )
            )
            return

        if request.method in ASYNC_METHODS:
            self._submit(handler, request)
        else:
            self._run(handler, request)

    def _run(self, handler: Handler, request: Request) -> None:
        try:
            result = handler(self, request)
        except CancelledError as exc:
            self._writer.write(encode_error(request.id, exc))
        except SipraError as exc:
            self._writer.write(encode_error(request.id, exc))
        except Exception as exc:  # pragma: no cover - last-resort guard
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            self._writer.write(
                encode_error(
                    request.id,
                    SipraError(ErrorCode.INTERNAL, f"Unexpected failure: {exc}"),
                )
            )
        else:
            self._writer.write(encode_response(request.id, result))

    def _submit(self, handler: Handler, request: Request) -> Future:
        job_id = str(request.params.get("jobId") or request.id)
        self.emit_event("job:started", {"jobId": job_id, "method": request.method}, request.id)

        def task() -> None:
            try:
                self._run(handler, request)
            finally:
                self._release_token(job_id)
                self.emit_event("job:finished", {"jobId": job_id}, request.id)

        return self._pool.submit(task)

    def serve_forever(self, stdin=None) -> int:
        stream = stdin if stdin is not None else sys.stdin
        self.emit_event(
            "ready",
            {"protocolVersion": PROTOCOL_VERSION, "version": __version__, "pid": os.getpid()},
        )
        try:
            for line in stream:
                if self._stopping.is_set():
                    break
                if not line.strip():
                    continue
                self.handle_line(line)
        except KeyboardInterrupt:  # pragma: no cover
            pass
        finally:
            self.shutdown()
        return 0

    def shutdown(self) -> None:
        self._stopping.set()
        with self._tokens_lock:
            tokens = list(self._tokens.values())
        for token in tokens:
            token.cancel()
        self._pool.shutdown(wait=False, cancel_futures=True)


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _h_ping(server: SipraServer, request: Request) -> dict:
    return {"pong": True, "version": __version__, "protocolVersion": PROTOCOL_VERSION}


def _h_capabilities(server: SipraServer, request: Request) -> dict:
    payload = server.registry.capabilities()
    payload.update(
        {
            "version": __version__,
            "protocolVersion": PROTOCOL_VERSION,
            "python": sys.version.split()[0],
            "stems": describe_stems(list(STEM_IDS)),
            "supportedExtensions": list(SUPPORTED_INPUT_EXTENSIONS),
            "ffmpeg": ffmpeg_path(),
            "ytdlp": {
                "available": youtube.is_available(),
                "path": youtube.ytdlp_path(),
                "allowedHosts": list(youtube.ALLOWED_HOSTS),
            },
        }
    )
    try:
        import torch

        payload["torch"] = {
            "version": torch.__version__,
            "cuda": bool(torch.cuda.is_available()),
            "cudaDevice": torch.cuda.get_device_name(0)
            if torch.cuda.is_available()
            else None,
        }
    except Exception:
        payload["torch"] = None
    return payload


def _h_probe(server: SipraServer, request: Request) -> dict:
    return probe(require(request.params, "path", str))


def _h_validate(server: SipraServer, request: Request) -> dict:
    path = require(request.params, "path", str)
    info = local_ingest.validate_input(path)
    info["fingerprint"] = local_ingest.file_fingerprint(path)
    return info


def _h_import(server: SipraServer, request: Request) -> dict:
    path = require(request.params, "path", str)
    destination = require(request.params, "destinationDir", str)
    imported = local_ingest.import_file(path, destination)
    info = probe(imported)
    info["fingerprint"] = local_ingest.file_fingerprint(imported)
    return info


def _h_analyze(server: SipraServer, request: Request) -> dict:
    path = require(request.params, "path", str)
    job_id = str(optional(request.params, "jobId", str) or request.id)
    include_beats = bool(optional(request.params, "includeBeats", bool, False))
    profile = str(optional(request.params, "keyProfile", str, "temperley"))
    report = server._progress_fn(request.id, job_id)
    analysis = analyse_file(
        path, include_beats=include_beats, key_profile=profile, on_progress=report
    )
    return analysis.to_dict(include_beats=include_beats)


def _h_peaks(server: SipraServer, request: Request) -> dict:
    path = require(request.params, "path", str)
    output = optional(request.params, "outputPath", str)
    bucket = int(optional(request.params, "samplesPerBucket", int, DEFAULT_SAMPLES_PER_BUCKET))
    buf = load_audio(path)
    data = compute_peaks(buf.data, buf.sample_rate, bucket)
    target = Path(output) if output else Path(path).with_suffix(".speaks")
    write_peaks(target, data)
    return {
        "path": str(target),
        "bucketCount": data.bucket_count,
        "samplesPerBucket": data.samples_per_bucket,
        "durationSeconds": round(data.duration_seconds, 4),
        "sampleRate": data.sample_rate,
    }


def _h_separate(server: SipraServer, request: Request) -> dict:
    from .separation import separate_track

    params = request.params
    job_id = str(optional(params, "jobId", str) or request.id)
    token = server._register_token(job_id)
    report = server._progress_fn(request.id, job_id)

    stems = optional(params, "stems", list)
    if stems is not None:
        stems = [str(s) for s in stems]

    outcome = separate_track(
        input_path=require(params, "path", str),
        output_dir=require(params, "outputDir", str),
        registry=server.registry,
        engine_id=optional(params, "engine", str),
        model_id=optional(params, "model", str),
        stems=stems,
        device=optional(params, "device", str),
        shifts=int(optional(params, "shifts", int, 0)),
        overlap=float(optional(params, "overlap", (int, float), 0.25)),
        segment=optional(params, "segment", (int, float)),
        jobs=int(optional(params, "jobs", int, 0)),
        analyse=bool(optional(params, "analyse", bool, True)),
        on_progress=report,
        token=token,
    )
    payload = outcome.to_dict()
    payload["jobId"] = job_id
    return payload


def _h_export_mix(server: SipraServer, request: Request) -> dict:
    params = request.params
    job_id = str(optional(params, "jobId", str) or request.id)
    token = server._register_token(job_id)
    report = server._progress_fn(request.id, job_id)

    tracks = require(params, "tracks", list)
    result = export_mix(
        tracks=tracks,
        output_path=require(params, "outputPath", str),
        output_format=str(optional(params, "format", str, "wav")),
        bit_depth=int(optional(params, "bitDepth", int, 24)),
        master_gain_db=float(optional(params, "masterGainDb", (int, float), 0.0)),
        normalise=bool(optional(params, "normalise", bool, False)),
        start_seconds=optional(params, "startSeconds", (int, float)),
        end_seconds=optional(params, "endSeconds", (int, float)),
        on_progress=report,
        token=token,
    )
    result["jobId"] = job_id
    return result


def _h_youtube_available(server: SipraServer, request: Request) -> dict:
    return {
        "available": youtube.is_available(),
        "path": youtube.ytdlp_path(),
        "allowedHosts": list(youtube.ALLOWED_HOSTS),
        "maxDurationSeconds": youtube.MAX_DURATION_SECONDS,
    }


def _h_youtube_metadata(server: SipraServer, request: Request) -> dict:
    return youtube.fetch_metadata(require(request.params, "url", str))


def _h_youtube_download(server: SipraServer, request: Request) -> dict:
    params = request.params
    job_id = str(optional(params, "jobId", str) or request.id)
    token = server._register_token(job_id)
    media = youtube.download_audio(
        url=require(params, "url", str),
        destination_dir=require(params, "destinationDir", str),
        rights_confirmed=bool(optional(params, "rightsConfirmed", bool, False)),
        on_progress=server._progress_fn(request.id, job_id),
        token=token,
    )
    payload = media.to_dict()
    payload["jobId"] = job_id
    return payload


def _h_cancel(server: SipraServer, request: Request) -> dict:
    job_id = require(request.params, "jobId", str)
    return {"jobId": job_id, "cancelled": server.cancel_job(job_id)}


def _h_shutdown(server: SipraServer, request: Request) -> dict:
    server._stopping.set()
    return {"stopping": True}


HANDLERS: dict[str, Handler] = {
    "ping": _h_ping,
    "capabilities": _h_capabilities,
    "probe": _h_probe,
    "ingest.validate": _h_validate,
    "ingest.import": _h_import,
    "analyze": _h_analyze,
    "peaks": _h_peaks,
    "separate": _h_separate,
    "mix.export": _h_export_mix,
    "youtube.available": _h_youtube_available,
    "youtube.metadata": _h_youtube_metadata,
    "youtube.download": _h_youtube_download,
    "cancel": _h_cancel,
    "shutdown": _h_shutdown,
}

# Methods dispatched to the background worker.
ASYNC_METHODS: frozenset[str] = frozenset(
    {"analyze", "peaks", "separate", "mix.export", "youtube.download", "youtube.metadata"}
)
