"""Tests for stage tracing.

Tracing is the only account of what a job was doing when it appeared to
freeze, so the properties worth pinning down are: it is on unless
explicitly silenced, it writes to stderr and never stdout, and it cannot
fail a job no matter what it is handed.
"""

from __future__ import annotations

import pytest

from sipra_core.trace import Throttle, is_tracing, trace


class TestIsTracing:
    def test_is_on_by_default(self, monkeypatch):
        """The default matters.

        This was opt-in until a stalled job was reported from a packaged
        build, where the switch was off — so the mechanism built to explain
        a stall was inert in the only place stalls were seen.
        """
        monkeypatch.delenv("SIPRA_TRACE_STAGES", raising=False)
        assert is_tracing() is True

    def test_is_off_when_explicitly_silenced(self, monkeypatch):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "0")
        assert is_tracing() is False

    @pytest.mark.parametrize("value", ["1", "yes", "true", "on", ""])
    def test_anything_other_than_zero_leaves_it_on(self, monkeypatch, value):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", value)
        assert is_tracing() is True


class TestTrace:
    def test_writes_to_stderr_and_never_to_stdout(self, monkeypatch, capsys):
        """stdout is the NDJSON protocol channel.

        A trace line written there would be parsed as a protocol message,
        or fail to parse and be reported as engine noise.
        """
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        trace("writing a stem", stem="bass")
        captured = capsys.readouterr()
        assert captured.out == ""
        assert "writing a stem" in captured.err
        assert "stem=bass" in captured.err

    def test_writes_nothing_when_silenced(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "0")
        trace("should not appear")
        assert capsys.readouterr().err == ""

    def test_each_line_carries_uptime_and_the_gap_since_the_last(self, monkeypatch, capsys):
        """The gap is the diagnosis.

        A stall does not show up as a missing line. It shows up as an
        ordinary line with a large number in front of it.
        """
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        trace("first")
        trace("second")
        err = capsys.readouterr().err.strip().splitlines()
        assert len(err) == 2
        for line in err:
            assert line.startswith("[sipra ")
            assert "s +" in line

    def test_drops_fields_with_no_value(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")
        trace("partial", present="yes", missing=None)
        err = capsys.readouterr().err
        assert "present=yes" in err
        assert "missing" not in err

    def test_a_value_that_cannot_be_formatted_does_not_raise(self, monkeypatch, capsys):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")

        class Hostile:
            def __str__(self) -> str:
                raise RuntimeError("no")

            __repr__ = __str__

        trace("hostile", value=Hostile())
        # Swallowed, not raised. Whether a line came out is not the point.
        capsys.readouterr()

    def test_a_broken_stderr_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("SIPRA_TRACE_STAGES", "1")

        class Broken:
            def write(self, _text: str) -> int:
                raise OSError("pipe closed")

            def flush(self) -> None:
                raise OSError("pipe closed")

        monkeypatch.setattr("sys.stderr", Broken())
        trace("into the void")


class TestThrottle:
    def test_lets_the_first_event_through(self):
        assert Throttle(60.0).ready() is True

    def test_holds_back_the_rest_of_the_interval(self):
        throttle = Throttle(60.0)
        assert throttle.ready() is True
        assert throttle.ready() is False
        assert throttle.ready() is False

    def test_forcing_ignores_the_interval(self):
        throttle = Throttle(60.0)
        throttle.ready()
        assert throttle.ready(force=True) is True

    def test_a_zero_interval_never_holds_anything_back(self):
        throttle = Throttle(0.0)
        assert all(throttle.ready() for _ in range(5))

    def test_resetting_opens_it_again(self):
        throttle = Throttle(60.0)
        throttle.ready()
        throttle.reset()
        assert throttle.ready() is True
