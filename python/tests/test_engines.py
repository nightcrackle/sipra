from __future__ import annotations

import numpy as np
import pytest

from sipra_core.engines.base import (
    CancellationToken,
    ModelInfo,
    SeparationEngine,
    SeparationRequest,
)
from sipra_core.engines.demucs_engine import DemucsEngine
from sipra_core.engines.registry import EngineRegistry
from sipra_core.engines.testing import FixtureEngine
from sipra_core.errors import CancelledError, ErrorCode, SipraError
from sipra_core.stems import FOUR_STEM_SET, SIX_STEM_SET

from .conftest import sine, stereo


class _UnavailableEngine:
    id = "broken"
    label = "Broken"

    def is_available(self) -> bool:
        return False

    def unavailable_reason(self) -> str | None:
        return "dependencies missing"

    def models(self) -> list[ModelInfo]:
        return [ModelInfo(id="none", label="None", stems=FOUR_STEM_SET)]

    def devices(self) -> list[str]:
        return []

    def separate(self, request, on_progress=None, token=None):  # pragma: no cover
        raise SipraError(ErrorCode.ENGINE_UNAVAILABLE, "unavailable")


class TestCancellationToken:
    def test_starts_uncancelled(self):
        assert CancellationToken().cancelled is False

    def test_cancel_is_observable_and_raises(self):
        token = CancellationToken()
        token.cancel()
        assert token.cancelled is True
        with pytest.raises(CancelledError):
            token.raise_if_cancelled()

    def test_raise_is_a_noop_while_running(self):
        CancellationToken().raise_if_cancelled()


class TestFixtureEngine:
    def test_satisfies_the_engine_protocol(self):
        assert isinstance(FixtureEngine(), SeparationEngine)

    def test_is_always_available(self):
        engine = FixtureEngine()
        assert engine.is_available() is True
        assert engine.unavailable_reason() is None

    def test_produces_the_four_stem_set(self):
        result = FixtureEngine().separate(
            SeparationRequest(audio=stereo(sine(440, 0.5)), sample_rate=44100, model_id="fixture-4")
        )
        assert set(result.stems) == set(FOUR_STEM_SET)

    def test_produces_the_six_stem_set(self):
        result = FixtureEngine().separate(
            SeparationRequest(audio=stereo(sine(440, 0.5)), sample_rate=44100, model_id="fixture-6")
        )
        assert set(result.stems) == set(SIX_STEM_SET)

    def test_stems_sum_back_to_the_input(self):
        """The band split is complementary, which makes it a usable
        reference for the mix maths downstream."""
        audio = stereo(sine(440, 0.5) * 0.5 + sine(80, 0.5) * 0.3)
        result = FixtureEngine().separate(
            SeparationRequest(audio=audio, sample_rate=44100, model_id="fixture-4")
        )
        summed = sum(result.stems.values())
        assert np.allclose(summed, audio, atol=1e-3)

    def test_honours_a_stem_subset(self):
        result = FixtureEngine().separate(
            SeparationRequest(
                audio=stereo(sine(440, 0.3)),
                sample_rate=44100,
                model_id="fixture-4",
                stems=("vocals", "drums"),
            )
        )
        assert set(result.stems) == {"vocals", "drums"}

    def test_preserves_shape_and_rate(self):
        audio = stereo(sine(440, 0.5))
        result = FixtureEngine().separate(
            SeparationRequest(audio=audio, sample_rate=44100, model_id="fixture-4")
        )
        assert result.sample_rate == 44100
        assert result.stems["vocals"].shape == audio.shape

    def test_reports_monotonic_progress_finishing_at_one(self):
        seen: list[float] = []
        FixtureEngine().separate(
            SeparationRequest(audio=stereo(sine(440, 0.3)), sample_rate=44100, model_id="fixture-4"),
            on_progress=lambda _stage, fraction: seen.append(fraction),
        )
        assert seen == sorted(seen)
        assert seen[-1] == pytest.approx(1.0)

    def test_warns_that_it_is_not_a_real_separator(self):
        result = FixtureEngine().separate(
            SeparationRequest(audio=stereo(sine(440, 0.2)), sample_rate=44100, model_id="fixture-4")
        )
        assert any("not separated" in w for w in result.warnings)

    def test_cancellation_is_honoured(self):
        token = CancellationToken()
        token.cancel()
        with pytest.raises(CancelledError):
            FixtureEngine().separate(
                SeparationRequest(
                    audio=stereo(sine(440, 0.3)), sample_rate=44100, model_id="fixture-4"
                ),
                token=token,
            )

    def test_unknown_model_raises(self):
        with pytest.raises(SipraError) as info:
            FixtureEngine().separate(
                SeparationRequest(audio=stereo(sine(440, 0.1)), sample_rate=44100, model_id="nope")
            )
        assert info.value.code == ErrorCode.MODEL_UNAVAILABLE

    def test_empty_audio_raises(self):
        with pytest.raises(SipraError) as info:
            FixtureEngine().separate(
                SeparationRequest(
                    audio=np.zeros((2, 0), dtype=np.float32),
                    sample_rate=44100,
                    model_id="fixture-4",
                )
            )
        assert info.value.code == ErrorCode.SEPARATION_FAILED


class TestDemucsEngine:
    def test_satisfies_the_engine_protocol(self):
        assert isinstance(DemucsEngine(), SeparationEngine)

    def test_advertises_a_four_and_a_six_stem_model(self):
        by_id = {m.id: m for m in DemucsEngine().models()}
        assert set(by_id["htdemucs"].stems) == set(FOUR_STEM_SET)
        assert set(by_id["htdemucs_6s"].stems) == set(SIX_STEM_SET)

    def test_the_six_stem_model_is_flagged_experimental(self):
        """Guitar is passable and piano bleeds badly. The UI must be able
        to say so rather than presenting six equally trustworthy lanes."""
        by_id = {m.id: m for m in DemucsEngine().models()}
        assert by_id["htdemucs_6s"].experimental is True
        assert by_id["htdemucs"].experimental is False

    def test_cpu_is_always_an_available_device(self):
        assert "cpu" in DemucsEngine().devices()

    def test_reports_a_reason_when_torch_is_missing(self):
        engine = DemucsEngine()
        if not engine.is_available():
            assert engine.unavailable_reason()

    def test_separating_without_dependencies_raises_a_clear_error(self):
        engine = DemucsEngine()
        if engine.is_available():
            pytest.skip("Demucs is installed in this environment")
        with pytest.raises(SipraError) as info:
            engine.separate(
                SeparationRequest(
                    audio=stereo(sine(440, 0.2)), sample_rate=44100, model_id="htdemucs"
                )
            )
        assert info.value.code == ErrorCode.ENGINE_UNAVAILABLE


class TestProgressReporter:
    def test_scales_progress_across_a_multi_model_bag(self):
        from sipra_core.engines.demucs_engine import _ProgressReporter

        seen: list[float] = []
        reporter = _ProgressReporter(lambda _s, f: seen.append(f), None)
        reporter.callback({"models": 4, "model_idx_in_bag": 0, "audio_length": 100, "segment_offset": 50})
        reporter.callback({"models": 4, "model_idx_in_bag": 2, "audio_length": 100, "segment_offset": 0})
        assert seen == [pytest.approx(0.125), pytest.approx(0.5)]

    def test_never_moves_backwards(self):
        from sipra_core.engines.demucs_engine import _ProgressReporter

        seen: list[float] = []
        reporter = _ProgressReporter(lambda _s, f: seen.append(f), None)
        reporter.callback({"models": 1, "model_idx_in_bag": 0, "audio_length": 100, "segment_offset": 80})
        reporter.callback({"models": 1, "model_idx_in_bag": 0, "audio_length": 100, "segment_offset": 10})
        assert seen == [pytest.approx(0.8)]

    def test_malformed_payloads_are_ignored(self):
        from sipra_core.engines.demucs_engine import _ProgressReporter

        seen: list[float] = []
        reporter = _ProgressReporter(lambda _s, f: seen.append(f), None)
        reporter.callback({})
        reporter.callback({"models": 0, "audio_length": 0, "segment_offset": 0})
        reporter.callback({"models": "x"})
        assert seen == [] or all(0.0 <= v <= 1.0 for v in seen)

    def test_raises_when_the_token_is_cancelled(self):
        from sipra_core.engines.demucs_engine import _ProgressReporter

        token = CancellationToken()
        token.cancel()
        reporter = _ProgressReporter(lambda _s, _f: None, token)
        with pytest.raises(CancelledError):
            reporter.callback({"models": 1, "model_idx_in_bag": 0, "audio_length": 1, "segment_offset": 0})

    def test_counts_every_callback_even_once_the_bar_has_stopped_moving(self):
        """The heartbeat's evidence.

        The reported fraction is capped just under one and never moves
        backwards, so the last stretch of a separation produces callbacks
        that change nothing visible. The count is what shows the model is
        still running rather than hung.
        """
        from sipra_core.engines.demucs_engine import _ProgressReporter

        seen: list[float] = []
        reporter = _ProgressReporter(lambda _s, f: seen.append(f), None)
        for _ in range(10):
            reporter.callback(
                {"models": 1, "model_idx_in_bag": 0, "audio_length": 100, "segment_offset": 100}
            )
        assert reporter.calls == 10
        # One visible update, ten proofs of life.
        assert len(seen) == 1

    def test_counts_callbacks_even_with_no_progress_handler(self):
        from sipra_core.engines.demucs_engine import _ProgressReporter

        reporter = _ProgressReporter(None, None)
        reporter.callback({"models": 1, "model_idx_in_bag": 0, "audio_length": 100, "segment_offset": 10})
        assert reporter.calls == 1


class TestFriendlyFailure:
    def test_translates_a_cuda_out_of_memory_error(self):
        from sipra_core.engines.demucs_engine import _friendly_failure

        message = _friendly_failure(RuntimeError("CUDA out of memory. Tried to allocate"), "cuda")
        assert "GPU ran out of memory" in message
        assert "Settings" in message

    def test_translates_a_cpu_out_of_memory_error(self):
        from sipra_core.engines.demucs_engine import _friendly_failure

        assert "Ran out of memory" in _friendly_failure(RuntimeError("out of memory"), "cpu")

    def test_translates_a_download_failure(self):
        from sipra_core.engines.demucs_engine import _friendly_failure

        assert "internet" in _friendly_failure(OSError("connection refused"), "cpu")

    def test_falls_through_for_anything_else(self):
        from sipra_core.engines.demucs_engine import _friendly_failure

        assert "kaboom" in _friendly_failure(RuntimeError("kaboom"), "cpu")


class TestEngineRegistry:
    def test_lists_registered_engines(self):
        registry = EngineRegistry([FixtureEngine()])
        assert [e.id for e in registry.all()] == ["fixture"]

    def test_unknown_engine_id_raises(self):
        with pytest.raises(SipraError) as info:
            EngineRegistry([FixtureEngine()]).get("nope")
        assert info.value.code == ErrorCode.ENGINE_UNAVAILABLE

    def test_available_filters_out_broken_engines(self):
        registry = EngineRegistry([FixtureEngine(), _UnavailableEngine()])
        assert [e.id for e in registry.available()] == ["fixture"]

    def test_default_engine_raises_when_nothing_is_usable(self):
        with pytest.raises(SipraError) as info:
            EngineRegistry([_UnavailableEngine()]).default_engine()
        assert info.value.code == ErrorCode.ENGINE_UNAVAILABLE
        assert "broken" in info.value.details["engines"]

    def test_resolve_picks_a_default_model(self):
        engine, model = EngineRegistry([FixtureEngine()]).resolve(None, None)
        assert engine.id == "fixture"
        assert model == "fixture-4"

    def test_resolve_accepts_an_explicit_pair(self):
        _engine, model = EngineRegistry([FixtureEngine()]).resolve("fixture", "fixture-6")
        assert model == "fixture-6"

    def test_resolve_rejects_a_model_the_engine_does_not_have(self):
        with pytest.raises(SipraError) as info:
            EngineRegistry([FixtureEngine()]).resolve("fixture", "htdemucs")
        assert info.value.code == ErrorCode.MODEL_UNAVAILABLE

    def test_resolve_rejects_an_unavailable_engine(self):
        with pytest.raises(SipraError) as info:
            EngineRegistry([_UnavailableEngine()]).resolve("broken", None)
        assert info.value.code == ErrorCode.ENGINE_UNAVAILABLE

    def test_capabilities_describes_every_engine(self):
        payload = EngineRegistry([FixtureEngine(), _UnavailableEngine()]).capabilities()
        by_id = {e["id"]: e for e in payload["engines"]}
        assert by_id["fixture"]["available"] is True
        assert by_id["broken"]["available"] is False
        assert by_id["broken"]["unavailableReason"] == "dependencies missing"
        assert by_id["broken"]["devices"] == []

    def test_fixture_engine_is_off_unless_explicitly_enabled(self, monkeypatch):
        """Nobody should get frequency bands presented as separated stems
        by accident."""
        monkeypatch.delenv("SIPRA_ENABLE_FIXTURE_ENGINE", raising=False)
        assert "fixture" not in [e.id for e in EngineRegistry().all()]

    def test_fixture_engine_appears_when_the_flag_is_set(self, monkeypatch):
        monkeypatch.setenv("SIPRA_ENABLE_FIXTURE_ENGINE", "1")
        assert "fixture" in [e.id for e in EngineRegistry().all()]


class TestStderrRelay:
    """Relaying Demucs' output as it is produced.

    Demucs and torch.hub write to stdout, which is the protocol channel,
    so their output has to be diverted. It used to be collected and printed
    when the call returned — which meant a model download's progress bar
    appeared only once the download had finished, precisely when nobody
    needs it. The first run after installing looked frozen because of it.
    """

    def _relay(self, interval=0.0):
        from sipra_core.engines.demucs_engine import _StderrRelay

        return _StderrRelay("demucs", interval=interval)

    def test_emits_a_line_as_soon_as_it_is_complete(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay()
        relay.write("downloading 10%\n")
        assert "downloading 10%" in capsys.readouterr().err

    def test_treats_a_carriage_return_as_a_line_break(self, monkeypatch, capsys):
        # Progress bars redraw with \r and never emit \n until the end.
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay()
        relay.write("10%\r20%\r30%\r")
        err = capsys.readouterr().err
        assert "10%" in err and "30%" in err

    def test_rate_limits_a_redrawing_progress_bar(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay(interval=60.0)
        for percent in range(0, 100, 5):
            relay.write(f"{percent}%\r")
        # One gets through; the rest would bury the log.
        assert capsys.readouterr().err.count("demucs:") == 1

    def test_holds_a_partial_line_until_it_is_finished(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay()
        relay.write("half a ")
        assert capsys.readouterr().err == ""
        relay.write("line\n")
        assert "half a line" in capsys.readouterr().err

    def test_close_emits_the_remainder_even_when_throttled(self, monkeypatch, capsys):
        # The last line is the one that says how it ended.
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay(interval=60.0)
        relay.write("first\n")
        capsys.readouterr()
        relay.write("done, no newline")
        relay.close()
        assert "done, no newline" in capsys.readouterr().err

    def test_never_writes_to_stdout(self, monkeypatch, capsys):
        # stdout is the NDJSON protocol channel. A byte here corrupts it.
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay()
        relay.write("anything\n")
        assert capsys.readouterr().out == ""

    def test_flushes_a_producer_that_never_ends_a_line(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        relay = self._relay()
        relay.write("x" * 5000)
        assert "xxxx" in capsys.readouterr().err

    def test_reports_bytes_written_so_it_can_stand_in_for_a_stream(self):
        relay = self._relay()
        assert relay.write("four") == 4
        assert relay.write("") == 0

    def test_looks_enough_like_a_stream_for_redirect_stdout(self):
        from contextlib import redirect_stdout

        relay = self._relay()
        with redirect_stdout(relay):
            print("through the redirect")
        relay.close()
        assert relay.isatty() is False
        assert relay.encoding == "utf-8"
