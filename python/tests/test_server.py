from __future__ import annotations

import io
import json
import threading
import time

import numpy as np
import pytest

from sipra_core.engines.registry import EngineRegistry
from sipra_core.engines.testing import FixtureEngine
from sipra_core.errors import ErrorCode
from sipra_core.protocol import PROTOCOL_VERSION
from sipra_core.server import ASYNC_METHODS, HANDLERS, SipraServer

from .conftest import sine, stereo


class _CapturingStream(io.StringIO):
    """Records every line the server writes."""

    def __init__(self) -> None:
        super().__init__()
        self.lines: list[dict] = []
        self._lock = threading.Lock()

    def write(self, text: str) -> int:  # type: ignore[override]
        stripped = text.strip()
        if stripped:
            with self._lock:
                self.lines.append(json.loads(stripped))
        return len(text)

    def responses(self) -> list[dict]:
        with self._lock:
            return [line for line in self.lines if "ok" in line]

    def events(self, name: str | None = None) -> list[dict]:
        with self._lock:
            return [
                line
                for line in self.lines
                if "event" in line and (name is None or line["event"] == name)
            ]

    def wait_for_response(self, req_id: str, timeout: float = 30.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.responses():
                if line.get("id") == req_id:
                    return line
            time.sleep(0.01)
        raise AssertionError(f"no response for request {req_id} within {timeout}s")


@pytest.fixture
def stream() -> _CapturingStream:
    return _CapturingStream()


@pytest.fixture
def server(stream) -> SipraServer:
    instance = SipraServer(EngineRegistry([FixtureEngine()]), stdout=stream)
    yield instance
    instance.shutdown()


def send(server: SipraServer, method: str, params: dict | None = None, req_id: str = "1") -> None:
    payload = {"id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    server.handle_line(json.dumps(payload))


class TestDispatch:
    def test_ping_answers_with_a_version(self, server, stream):
        send(server, "ping")
        response = stream.responses()[0]
        assert response["ok"] is True
        assert response["result"]["pong"] is True
        assert response["result"]["protocolVersion"] == PROTOCOL_VERSION

    def test_unknown_method_is_rejected_with_the_known_list(self, server, stream):
        send(server, "does.not.exist")
        error = stream.responses()[0]["error"]
        assert error["code"] == ErrorCode.UNKNOWN_METHOD
        assert "ping" in error["details"]["known"]

    def test_malformed_json_produces_an_error_without_an_id(self, server, stream):
        server.handle_line("{not json")
        response = stream.responses()[0]
        assert response["ok"] is False
        assert response["error"]["code"] == ErrorCode.BAD_REQUEST
        assert "id" not in response

    def test_a_missing_parameter_is_reported_clearly(self, server, stream):
        send(server, "probe")
        assert stream.responses()[0]["error"]["code"] == ErrorCode.INVALID_PARAMS

    def test_a_domain_error_keeps_its_code(self, server, stream, tmp_path):
        send(server, "probe", {"path": str(tmp_path / "gone.wav")})
        assert stream.responses()[0]["error"]["code"] == ErrorCode.FILE_NOT_FOUND

    def test_every_async_method_is_a_real_handler(self):
        assert set(HANDLERS) >= ASYNC_METHODS

    def test_every_handler_is_callable(self):
        assert all(callable(handler) for handler in HANDLERS.values())


class TestCapabilities:
    def test_describes_engines_stems_and_formats(self, server, stream):
        send(server, "capabilities")
        result = stream.responses()[0]["result"]
        assert result["protocolVersion"] == PROTOCOL_VERSION
        assert [e["id"] for e in result["engines"]] == ["fixture"]
        assert {s["id"] for s in result["stems"]} == {
            "vocals", "drums", "bass", "guitar", "piano", "other"
        }
        assert ".wav" in result["supportedExtensions"]
        assert "allowedHosts" in result["ytdlp"]

    def test_flags_the_experimental_stems(self, server, stream):
        send(server, "capabilities")
        by_id = {s["id"]: s for s in stream.responses()[0]["result"]["stems"]}
        assert by_id["piano"]["experimental"] is True
        assert by_id["vocals"]["experimental"] is False
        assert "bleeding" in by_id["piano"]["note"]

    def test_the_payload_is_json_serialisable(self, server, stream):
        send(server, "capabilities")
        json.dumps(stream.responses()[0])


class TestFileMethods:
    def test_probe_returns_metadata(self, server, stream, wav_file):
        send(server, "probe", {"path": wav_file(stereo(sine(440, 1.0)), name="s.wav")})
        result = stream.responses()[0]["result"]
        assert result["channels"] == 2
        assert result["durationSeconds"] == pytest.approx(1.0, abs=0.01)

    def test_validate_adds_a_fingerprint(self, server, stream, wav_file):
        send(server, "ingest.validate", {"path": wav_file(stereo(sine(440, 0.5)))})
        assert len(stream.responses()[0]["result"]["fingerprint"]) == 64

    def test_validate_rejects_an_unsupported_extension(self, server, stream, tmp_path):
        junk = tmp_path / "notes.txt"
        junk.write_text("hello")
        send(server, "ingest.validate", {"path": str(junk)})
        assert stream.responses()[0]["error"]["code"] == ErrorCode.UNSUPPORTED_FORMAT

    def test_import_copies_into_the_library(self, server, stream, wav_file, tmp_path):
        send(
            server,
            "ingest.import",
            {"path": wav_file(stereo(sine(440, 0.5))), "destinationDir": str(tmp_path / "lib")},
        )
        result = stream.responses()[0]["result"]
        assert result["path"].endswith(".wav")
        assert "lib" in result["path"]


class TestAsyncJobs:
    def test_peaks_runs_on_the_worker_and_emits_lifecycle_events(
        self, server, stream, wav_file, tmp_path
    ):
        send(
            server,
            "peaks",
            {"path": wav_file(stereo(sine(440, 1.0))), "outputPath": str(tmp_path / "p.speaks")},
            req_id="p1",
        )
        response = stream.wait_for_response("p1")
        assert response["ok"] is True
        assert response["result"]["bucketCount"] > 0
        assert stream.events("job:started")
        assert stream.events("job:finished")

    def test_separate_reports_progress_and_writes_stems(
        self, server, stream, wav_file, tmp_path
    ):
        send(
            server,
            "separate",
            {
                "path": wav_file(stereo(sine(440, 1.0))),
                "outputDir": str(tmp_path / "track"),
                "engine": "fixture",
                "model": "fixture-4",
                "analyse": False,
                "jobId": "job-7",
            },
            req_id="s1",
        )
        response = stream.wait_for_response("s1")
        assert response["ok"] is True
        assert len(response["result"]["stems"]) == 4
        assert response["result"]["jobId"] == "job-7"

        fractions = [e["data"]["fraction"] for e in stream.events("progress")]
        assert fractions == sorted(fractions)
        assert fractions[-1] == pytest.approx(1.0)
        assert all(e["data"]["jobId"] == "job-7" for e in stream.events("progress"))

    def test_analyze_returns_a_full_report(self, server, stream, wav_file, music_like):
        send(server, "analyze", {"path": wav_file(music_like, name="m.wav")}, req_id="a1")
        result = stream.wait_for_response("a1")["result"]
        assert "bpm" in result and "integratedLufs" in result and "keyLabel" in result

    def test_mix_export_sums_the_given_stems(self, server, stream, tmp_path):
        import soundfile as sf

        first, second = tmp_path / "a.wav", tmp_path / "b.wav"
        sf.write(str(first), np.full((44100, 2), 0.2, dtype=np.float32), 44100, subtype="FLOAT")
        sf.write(str(second), np.full((44100, 2), 0.3, dtype=np.float32), 44100, subtype="FLOAT")
        send(
            server,
            "mix.export",
            {
                "tracks": [{"path": str(first)}, {"path": str(second)}],
                "outputPath": str(tmp_path / "mix.wav"),
                "bitDepth": 32,
            },
            req_id="m1",
        )
        result = stream.wait_for_response("m1")["result"]
        assert result["stemCount"] == 2
        from sipra_core.audio_io import load_audio

        assert load_audio(result["path"]).data.mean() == pytest.approx(0.5, abs=1e-3)


class TestCancellation:
    def test_cancelling_an_unknown_job_reports_false(self, server, stream):
        send(server, "cancel", {"jobId": "nope"})
        assert stream.responses()[0]["result"] == {"jobId": "nope", "cancelled": False}

    def test_cancel_requires_a_job_id(self, server, stream):
        send(server, "cancel", {})
        assert stream.responses()[0]["error"]["code"] == ErrorCode.INVALID_PARAMS

    def test_cancel_reaches_a_registered_token(self, server):
        token = server._register_token("job-a")
        assert server.cancel_job("job-a") is True
        assert token.cancelled is True

    def test_shutdown_cancels_every_running_job(self, server):
        first = server._register_token("job-a")
        second = server._register_token("job-b")
        server.shutdown()
        assert first.cancelled and second.cancelled


class TestServeLoop:
    def test_emits_a_ready_event_and_processes_a_line(self, stream):
        server = SipraServer(EngineRegistry([FixtureEngine()]), stdout=stream)
        server.serve_forever(io.StringIO('{"id":"1","method":"ping"}\n'))
        ready = stream.events("ready")
        assert ready and ready[0]["data"]["protocolVersion"] == PROTOCOL_VERSION
        assert stream.responses()[0]["result"]["pong"] is True

    def test_blank_lines_are_skipped(self, stream):
        server = SipraServer(EngineRegistry([FixtureEngine()]), stdout=stream)
        server.serve_forever(io.StringIO('\n\n  \n{"id":"1","method":"ping"}\n'))
        assert len(stream.responses()) == 1

    def test_shutdown_request_stops_the_loop(self, stream):
        server = SipraServer(EngineRegistry([FixtureEngine()]), stdout=stream)
        server.serve_forever(
            io.StringIO('{"id":"1","method":"shutdown"}\n{"id":"2","method":"ping"}\n')
        )
        assert [r["id"] for r in stream.responses()] == ["1"]


class TestStreamIntegrity:
    def test_a_track_name_with_a_newline_cannot_desynchronise_the_stream(
        self, server, stream, tmp_path
    ):
        """One raw newline in a payload would split a message in two."""
        import soundfile as sf

        nasty = tmp_path / "line break.wav"
        sf.write(str(nasty), np.zeros((1000, 2), dtype=np.float32), 44100)
        send(server, "probe", {"path": str(nasty)})
        assert len(stream.lines) == 1
        assert stream.responses()[0]["ok"] is True


class TestPrepareModel:
    """First-run model preparation.

    The reason this method exists: the weights download and the compute
    device's cold start used to be paid inside whichever separation
    happened to run first, where the progress bar had no way to describe
    either. The first track anyone separated after installing appeared to
    stop a few percent in and stay there.
    """

    def test_prepares_the_default_model(self, server, stream):
        send(server, "models.prepare", {"engine": "fixture"}, req_id="m1")
        result = stream.wait_for_response("m1")["result"]
        assert result["prepared"] is True
        assert result["engine"] == "fixture"

    def test_reports_progress_on_the_model_stage(self, server, stream):
        send(server, "models.prepare", {"engine": "fixture", "jobId": "setup"}, req_id="m2")
        stream.wait_for_response("m2")
        stages = {event["data"]["stage"] for event in stream.events("progress")}
        assert stages, "preparation must report, or it is the silent wait it replaced"
        assert stages == {"model"}

    def test_rejects_a_model_the_engine_does_not_have(self, server, stream):
        send(server, "models.prepare", {"engine": "fixture", "model": "nope"}, req_id="m3")
        error = stream.wait_for_response("m3")["error"]
        assert error["code"] == ErrorCode.MODEL_UNAVAILABLE

    def test_runs_on_the_worker_not_the_reader_thread(self):
        # It downloads weights and runs an inference. On the reader thread
        # that would block every ping and every cancel for its duration.
        assert "models.prepare" in ASYNC_METHODS
