from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from sipra_core import audio_io
from sipra_core.audio_io import (
    AudioBuffer,
    load_audio,
    mix_down,
    peak_normalise,
    probe,
    resample,
    write_audio,
)
from sipra_core.errors import CancelledError, ErrorCode, SipraError

from .conftest import dbfs_sine, sine, stereo


class TestAudioBuffer:
    def test_reports_shape_derived_properties(self):
        buf = AudioBuffer(np.zeros((2, 44100), dtype=np.float32), 44100)
        assert (buf.channels, buf.frames, buf.duration) == (2, 44100, 1.0)

    def test_mono_downmix_averages_channels(self):
        data = np.stack([np.ones(100, dtype=np.float32), np.zeros(100, dtype=np.float32)])
        assert np.allclose(AudioBuffer(data, 44100).to_mono(), 0.5)

    def test_mono_downmix_of_mono_is_a_passthrough(self):
        data = np.arange(10, dtype=np.float32)[np.newaxis, :]
        assert np.array_equal(AudioBuffer(data, 44100).to_mono(), data[0])

    def test_zero_sample_rate_does_not_divide_by_zero(self):
        assert AudioBuffer(np.zeros((1, 10), dtype=np.float32), 0).duration == 0.0


class TestLoadAudio:
    def test_round_trips_a_stereo_wav(self, wav_file):
        original = stereo(sine(440, 1.0))
        buf = load_audio(wav_file(original))
        assert buf.channels == 2
        assert buf.sample_rate == 44100
        assert np.allclose(buf.data, original, atol=1e-6)

    def test_shape_is_channels_by_samples(self, wav_file):
        buf = load_audio(wav_file(stereo(sine(440, 0.5))))
        assert buf.data.shape == (2, 22050)

    def test_mono_flag_folds_channels_down(self, wav_file):
        buf = load_audio(wav_file(stereo(sine(440, 0.5))), mono=True)
        assert buf.channels == 1

    def test_target_sample_rate_resamples(self, wav_file):
        buf = load_audio(wav_file(stereo(sine(440, 1.0))), target_sample_rate=22050)
        assert buf.sample_rate == 22050
        assert buf.frames == pytest.approx(22050, abs=2)

    def test_missing_file_raises_file_not_found(self, tmp_path):
        with pytest.raises(SipraError) as info:
            load_audio(tmp_path / "nope.wav")
        assert info.value.code == ErrorCode.FILE_NOT_FOUND

    def test_directory_raises_file_not_found(self, tmp_path):
        with pytest.raises(SipraError) as info:
            load_audio(tmp_path)
        assert info.value.code == ErrorCode.FILE_NOT_FOUND

    def test_empty_file_raises_decode_failed(self, tmp_path):
        empty = tmp_path / "empty.wav"
        empty.write_bytes(b"")
        with pytest.raises(SipraError) as info:
            load_audio(empty)
        assert info.value.code == ErrorCode.DECODE_FAILED

    def test_garbage_file_is_rejected_cleanly(self, tmp_path, monkeypatch):
        junk = tmp_path / "junk.wav"
        junk.write_bytes(b"this is not audio" * 100)
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: None)
        with pytest.raises(SipraError) as info:
            load_audio(junk)
        assert info.value.code == ErrorCode.DECODE_FAILED

    def test_oversized_file_is_refused_before_decoding(self, tmp_path, monkeypatch):
        path = tmp_path / "huge.wav"
        sf.write(str(path), np.zeros((100, 2), dtype=np.float32), 44100)
        monkeypatch.setattr(audio_io, "MAX_INPUT_BYTES", 10)
        with pytest.raises(SipraError) as info:
            load_audio(path)
        assert info.value.code == ErrorCode.UNSUPPORTED_FORMAT

    def test_overlong_audio_is_refused(self, wav_file, monkeypatch):
        monkeypatch.setattr(audio_io, "MAX_DURATION_SECONDS", 0.1)
        with pytest.raises(SipraError) as info:
            load_audio(wav_file(stereo(sine(440, 1.0))))
        assert info.value.code == ErrorCode.UNSUPPORTED_FORMAT


class TestProbe:
    def test_reports_metadata_without_decoding(self, wav_file):
        info = probe(wav_file(stereo(sine(440, 2.0)), name="song.wav"))
        assert info["name"] == "song.wav"
        assert info["extension"] == ".wav"
        assert info["channels"] == 2
        assert info["sampleRate"] == 44100
        assert info["durationSeconds"] == pytest.approx(2.0, abs=0.01)
        assert info["sizeBytes"] > 0

    def test_unreadable_file_still_returns_a_shape(self, tmp_path):
        junk = tmp_path / "junk.m4a"
        junk.write_bytes(b"\x00" * 64)
        info = probe(junk)
        assert info["sampleRate"] is None
        assert info["sizeBytes"] == 64

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(SipraError):
            probe(tmp_path / "absent.wav")


class TestResample:
    def test_changes_the_frame_count_proportionally(self):
        buf = AudioBuffer(stereo(sine(440, 1.0)), 44100)
        assert resample(buf, 22050).frames == pytest.approx(22050, abs=2)

    def test_preserves_amplitude_of_a_low_frequency_tone(self):
        buf = AudioBuffer(sine(100, 1.0)[np.newaxis, :], 44100)
        out = resample(buf, 22050)
        assert float(np.max(np.abs(out.data))) == pytest.approx(1.0, abs=0.02)

    def test_same_rate_is_a_noop(self):
        buf = AudioBuffer(stereo(sine(440, 0.1)), 44100)
        assert resample(buf, 44100) is buf

    def test_upsampling_works_too(self):
        buf = AudioBuffer(sine(200, 0.5, 22050)[np.newaxis, :], 22050)
        assert resample(buf, 44100).frames == pytest.approx(22050, abs=2)

    def test_rejects_a_non_positive_rate(self):
        with pytest.raises(SipraError):
            resample(AudioBuffer(np.zeros((1, 10), dtype=np.float32), 44100), 0)

    def test_per_channel_conversion_matches_converting_the_whole_array(self):
        """The safety net on splitting this up.

        Channels are converted one at a time to halve the peak allocation
        and to give the caller something to report. That is only acceptable
        if it changes nothing about the audio, so this pins it to the
        whole-array result sample for sample.
        """
        from math import gcd

        from scipy.signal import resample_poly

        left = sine(220, 0.5, 48000)
        right = sine(770, 0.5, 48000) * 0.6
        buf = AudioBuffer(np.stack([left, right]).astype(np.float32), 48000)

        divisor = gcd(48000, 44100)
        expected = resample_poly(buf.data, 44100 // divisor, 48000 // divisor, axis=1)
        out = resample(buf, 44100)

        assert out.data.shape == expected.shape
        assert np.allclose(out.data, expected, atol=1e-6)

    def test_reports_progress_from_zero_to_one(self):
        """A conversion that reports nothing looks like one that stopped.

        This ran unreported between the end of separation and the first
        stem write, which is where a real job sat at 86% with no way to
        tell whether anything was happening.
        """
        seen: list[float] = []
        buf = AudioBuffer(stereo(sine(440, 0.2, 48000)), 48000)
        resample(buf, 44100, on_progress=seen.append)
        assert seen[0] == 0.0
        assert seen[-1] == 1.0
        assert seen == sorted(seen)
        # One report per channel, plus the closing one.
        assert len(seen) == 3

    def test_a_missing_progress_callback_is_harmless(self):
        buf = AudioBuffer(stereo(sine(440, 0.1, 48000)), 48000)
        assert resample(buf, 44100, on_progress=None).sample_rate == 44100

    def test_converts_a_strided_buffer_the_same_as_a_contiguous_one(self):
        """A channel of a transposed buffer is strided.

        The polyphase filter walks it sample by sample, so it is made
        contiguous first. This checks that doing so changes no values.
        """
        interleaved = np.stack([sine(300, 0.3, 48000), sine(900, 0.3, 48000)], axis=1)
        strided = interleaved.T
        assert not strided.flags["C_CONTIGUOUS"]

        from_strided = resample(AudioBuffer(strided, 48000), 44100)
        from_contiguous = resample(AudioBuffer(np.ascontiguousarray(strided), 48000), 44100)
        assert np.array_equal(from_strided.data, from_contiguous.data)

    def test_output_is_contiguous(self):
        buf = AudioBuffer(stereo(sine(440, 0.2, 48000)), 48000)
        assert resample(buf, 44100).data.flags["C_CONTIGUOUS"]

    def test_converts_mono(self):
        buf = AudioBuffer(sine(440, 0.2, 48000)[np.newaxis, :], 48000)
        out = resample(buf, 44100)
        assert out.data.shape[0] == 1
        assert out.frames == pytest.approx(8820, abs=2)

    def test_the_common_case_is_48k_to_cd_rate(self):
        """What every URL import needs.

        Streaming audio arrives at 48 kHz and every separation model here
        works at 44.1 kHz.
        """
        buf = AudioBuffer(stereo(sine(440, 1.0, 48000)), 48000)
        assert resample(buf, 44100).frames == pytest.approx(44100, abs=2)


class TestWriteAudio:
    def test_creates_parent_directories(self, tmp_path):
        target = tmp_path / "a" / "b" / "out.wav"
        write_audio(target, stereo(sine(440, 0.1)), 44100)
        assert target.exists()

    def test_round_trips_through_disk(self, tmp_path):
        original = stereo(sine(440, 0.2))
        path = write_audio(tmp_path / "o.wav", original, 44100, subtype="FLOAT")
        assert np.allclose(load_audio(path).data, original, atol=1e-6)

    def test_one_dimensional_input_is_written_as_mono(self, tmp_path):
        path = write_audio(tmp_path / "m.wav", sine(440, 0.1), 44100)
        assert load_audio(path).channels == 1

    def test_integer_output_clips_instead_of_wrapping(self, tmp_path):
        """libsndfile wraps on overflow, which turns a hot stem into noise."""
        hot = (sine(440, 0.1) * 3.0).astype(np.float32)
        path = write_audio(tmp_path / "hot.wav", hot, 44100, subtype="PCM_16")
        loaded = load_audio(path).data
        assert float(np.max(np.abs(loaded))) <= 1.0 + 1e-4

    def test_float_output_preserves_values_above_full_scale(self, tmp_path):
        hot = (sine(440, 0.1) * 2.0).astype(np.float32)
        path = write_audio(tmp_path / "hot.wav", hot, 44100, subtype="FLOAT")
        assert float(np.max(np.abs(load_audio(path).data))) > 1.5

    def test_rejects_three_dimensional_input(self, tmp_path):
        with pytest.raises(SipraError):
            write_audio(tmp_path / "x.wav", np.zeros((1, 2, 3), dtype=np.float32), 44100)


class TestPeakNormalise:
    def test_attenuates_a_hot_signal_to_the_ceiling(self):
        out = peak_normalise(dbfs_sine(0.0), ceiling_db=-1.0)
        assert float(np.max(np.abs(out))) == pytest.approx(10 ** (-1.0 / 20.0), abs=1e-3)

    def test_leaves_a_quiet_signal_alone(self):
        """Boosting would change the balance the user just mixed."""
        quiet = dbfs_sine(-20.0)
        assert np.array_equal(peak_normalise(quiet, ceiling_db=-1.0), quiet)

    def test_silence_is_returned_unchanged(self):
        silence = np.zeros(100, dtype=np.float32)
        assert np.array_equal(peak_normalise(silence), silence)


class TestMixDown:
    def test_sums_equal_length_stems(self):
        a = np.full((2, 100), 0.25, dtype=np.float32)
        b = np.full((2, 100), 0.5, dtype=np.float32)
        assert np.allclose(mix_down([a, b]), 0.75)

    def test_pads_shorter_stems(self):
        a = np.ones((2, 100), dtype=np.float32)
        b = np.ones((2, 50), dtype=np.float32)
        mixed = mix_down([a, b])
        assert mixed.shape == (2, 100)
        assert mixed[0, 0] == pytest.approx(2.0)
        assert mixed[0, 75] == pytest.approx(1.0)

    def test_broadcasts_a_mono_stem_across_channels(self):
        mixed = mix_down([np.ones((2, 10), dtype=np.float32), np.ones((1, 10), dtype=np.float32)])
        assert mixed.shape == (2, 10)
        assert np.allclose(mixed, 2.0)

    def test_empty_input_raises(self):
        with pytest.raises(SipraError):
            mix_down([])


class TestDecodeReporting:
    """Decoding used to be one opaque call.

    A real job stopped inside it and left a log whose last line was
    "decoding <name>" with nothing after it — the same amount of help as no
    log at all. Decoding now reads in blocks, so it reports as it goes and
    notices a cancel partway through.
    """

    class _Token:
        def __init__(self, cancelled: bool = False) -> None:
            self._cancelled = cancelled

        @property
        def cancelled(self) -> bool:
            return self._cancelled

        def cancel(self) -> None:
            self._cancelled = True

    def test_reports_progress_while_decoding(self, wav_file):
        seen: list[float] = []
        path = wav_file(stereo(sine(440, 2.0)), name="long.wav")
        load_audio(path, on_progress=seen.append)
        assert seen, "a decode that reports nothing looks like one that stopped"
        assert seen == sorted(seen)
        assert seen[-1] == pytest.approx(1.0)

    def test_progress_stays_within_the_unit_interval(self, wav_file):
        seen: list[float] = []
        load_audio(wav_file(stereo(sine(440, 1.0))), on_progress=seen.append)
        assert all(0.0 <= value <= 1.0 for value in seen)

    def test_block_reads_produce_the_same_samples_as_one_read(self, wav_file, monkeypatch):
        """The safety net on splitting the read up.

        Reading in blocks is only acceptable if it changes nothing about
        the audio, so this pins it against a single-call read.
        """
        path = wav_file(stereo(sine(330, 1.0) * 0.7), name="blocks.wav")
        whole = load_audio(path)
        monkeypatch.setattr(audio_io, "DECODE_BLOCK_FRAMES", 1024)
        blocked = load_audio(path)
        assert blocked.data.shape == whole.data.shape
        assert np.array_equal(blocked.data, whole.data)

    def test_a_tiny_block_size_still_decodes_the_whole_file(self, wav_file, monkeypatch):
        monkeypatch.setattr(audio_io, "DECODE_BLOCK_FRAMES", 7)
        buf = load_audio(wav_file(stereo(sine(440, 0.1))))
        assert buf.frames == pytest.approx(4410, abs=2)

    def test_the_in_process_reader_is_cancelled_partway_through(
        self, wav_file, monkeypatch
    ):
        monkeypatch.setenv("SIPRA_DECODER", "libsndfile")
        monkeypatch.setattr(audio_io, "DECODE_BLOCK_FRAMES", 512)
        token = self._Token()
        path = wav_file(stereo(sine(440, 1.0)), name="cancelme.wav")

        def cancel_after_first(_fraction: float) -> None:
            token.cancel()

        with pytest.raises(CancelledError):
            load_audio(path, on_progress=cancel_after_first, token=token)

    def test_the_subprocess_reader_is_cancelled_too(self, wav_file, monkeypatch):
        if audio_io.ffmpeg_path() is None:
            pytest.skip("ffmpeg is not installed")
        monkeypatch.setenv("SIPRA_DECODER", "ffmpeg")
        token = self._Token(cancelled=True)
        with pytest.raises(CancelledError):
            load_audio(wav_file(stereo(sine(440, 0.5))), token=token)


    def test_an_uncancelled_token_changes_nothing(self, wav_file):
        buf = load_audio(wav_file(stereo(sine(440, 0.2))), token=self._Token())
        assert buf.frames > 0

    def test_output_is_contiguous_channels_first(self, wav_file):
        buf = load_audio(wav_file(stereo(sine(440, 0.2))))
        assert buf.data.shape[0] == 2
        assert buf.data.flags["C_CONTIGUOUS"]


class TestDecodeDeadlines:
    """Nothing that decodes may be able to wait forever.

    The downloader was given a timeout after a hung yt-dlp stopped an
    import. The identical defect stayed in this module until a hung ffmpeg
    stopped an import the same way. Both are covered now, and a static test
    in the ingest suite fails if a new one appears.
    """

    def test_the_decode_timeout_is_finite_and_generous(self):
        assert 60 < audio_io.DECODE_TIMEOUT_SECONDS < 60 * 60

    def test_the_probe_timeout_is_short(self):
        # It reads a header. If it cannot answer quickly it will not answer.
        assert 0 < audio_io.FFPROBE_TIMEOUT_SECONDS <= 60

    def test_a_decoder_that_never_finishes_is_killed(self, tmp_path):
        """A stand-in for ffmpeg that produces nothing and does not exit."""
        import subprocess
        import sys
        import textwrap

        script = tmp_path / "hang.py"
        script.write_text(
            textwrap.dedent(
                """
                import time
                time.sleep(600)
                """
            )
        )
        with pytest.raises(SipraError) as info:
            audio_io.run_bounded(
                [sys.executable, str(script)],
                expected_bytes=0,
                timeout=1.0,
                on_progress=None,
                token=None,
                label="stand-in",
            )
        assert info.value.code == ErrorCode.DECODE_FAILED
        assert "did not finish" in str(info.value)
        assert isinstance(subprocess.TimeoutExpired, type)

    def test_a_decoder_that_floods_stderr_does_not_deadlock(self, tmp_path):
        """The other half of the same lesson.

        A child blocked writing to a full stderr pipe, while the parent is
        blocked reading stdout, is a deadlock no timeout on `wait` can
        reach — the wait is never arrived at. stderr is drained on its own
        thread; this floods far past a pipe buffer to prove it.
        """
        import sys
        import textwrap

        script = tmp_path / "flood.py"
        script.write_text(
            textwrap.dedent(
                """
                import sys
                sys.stderr.write("x" * 512 * 1024)
                sys.stderr.flush()
                sys.stdout.buffer.write(b"\\x00\\x00\\x80\\x3f" * 16)
                sys.stdout.flush()
                """
            )
        )
        payload, stderr = audio_io.run_bounded(
            [sys.executable, str(script)],
            expected_bytes=64,
            timeout=30.0,
            on_progress=None,
            token=None,
            label="stand-in",
        )
        assert len(payload) == 64
        assert len(stderr) > 400_000

    def test_a_failing_decoder_reports_its_stderr(self, tmp_path):
        import sys
        import textwrap

        script = tmp_path / "fail.py"
        script.write_text(
            textwrap.dedent(
                """
                import sys
                sys.stderr.write("Invalid data found when processing input\\n")
                sys.exit(1)
                """
            )
        )
        with pytest.raises(SipraError) as info:
            audio_io.run_bounded(
                [sys.executable, str(script)],
                expected_bytes=0,
                timeout=30.0,
                on_progress=None,
                token=None,
                label="stand-in",
            )
        assert "Invalid data" in str(info.value.details.get("stderr", ""))

    def test_cancellation_kills_the_decoder(self, tmp_path):
        import sys
        import textwrap

        script = tmp_path / "slow.py"
        script.write_text(
            textwrap.dedent(
                """
                import time
                time.sleep(600)
                """
            )
        )

        class _Cancelled:
            cancelled = True

        with pytest.raises(CancelledError):
            audio_io.run_bounded(
                [sys.executable, str(script)],
                expected_bytes=0,
                timeout=60.0,
                on_progress=None,
                token=_Cancelled(),
                label="stand-in",
            )


class TestDecoderPreference:
    """Which reader runs, and why.

    Not a question about audio quality — libsndfile reads WAV, FLAC and Ogg
    perfectly well. It is a question about what can be stopped. libsndfile
    reads inside this process, and a native read that stalls cannot be
    timed out, cancelled or killed; it holds the only worker there is for
    as long as the application stays open. A child process can be given a
    deadline, watched, and killed. A real import stalled seventy per cent
    of the way through a freshly downloaded file and sat there for eight
    minutes, on the in-process path, with nothing able to end it.
    """

    def test_prefers_the_subprocess_when_ffmpeg_is_available(self, monkeypatch):
        monkeypatch.delenv("SIPRA_DECODER", raising=False)
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
        assert audio_io.prefer_subprocess_decoder() is True

    def test_falls_back_in_process_when_ffmpeg_is_missing(self, monkeypatch):
        monkeypatch.delenv("SIPRA_DECODER", raising=False)
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: None)
        assert audio_io.prefer_subprocess_decoder() is False

    @pytest.mark.parametrize("value,expected", [("libsndfile", False), ("ffmpeg", True)])
    def test_can_be_forced_either_way(self, monkeypatch, value, expected):
        monkeypatch.setenv("SIPRA_DECODER", value)
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: None if expected else "/x")
        assert audio_io.prefer_subprocess_decoder() is expected

    def test_an_unrecognised_setting_is_ignored(self, monkeypatch):
        monkeypatch.setenv("SIPRA_DECODER", "nonsense")
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
        assert audio_io.prefer_subprocess_decoder() is True

    def test_both_readers_produce_the_same_audio(self, wav_file, monkeypatch):
        """The preference must not change what the user hears."""
        if audio_io.ffmpeg_path() is None:
            pytest.skip("ffmpeg is not installed")
        path = wav_file(stereo(sine(440, 0.5) * 0.6), name="both.wav")

        monkeypatch.setenv("SIPRA_DECODER", "libsndfile")
        native = load_audio(path)
        monkeypatch.setenv("SIPRA_DECODER", "ffmpeg")
        piped = load_audio(path)

        assert native.sample_rate == piped.sample_rate
        assert native.data.shape == piped.data.shape
        assert np.allclose(native.data, piped.data, atol=1e-4)

    def test_a_stall_is_not_retried_on_the_reader_that_cannot_be_stopped(
        self, wav_file, monkeypatch
    ):
        """A deadline is a fact about the file, not a reason to hang.

        Falling back to the in-process reader after the bounded one gave up
        would take a decode that correctly refused to wait forever and make
        it wait forever.
        """
        monkeypatch.setattr(audio_io, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
        monkeypatch.delenv("SIPRA_DECODER", raising=False)

        def stalled(*_args, **_kwargs):
            raise SipraError(
                ErrorCode.INTERNAL, "stand-in stopped producing output"
            )

        monkeypatch.setattr(audio_io, "_load_with_ffmpeg", stalled)
        called: list[str] = []
        monkeypatch.setattr(
            audio_io,
            "_load_with_soundfile",
            lambda *a, **k: called.append("fallback") or (_ for _ in ()).throw(AssertionError),
        )
        with pytest.raises(SipraError):
            load_audio(wav_file(stereo(sine(440, 0.2))))
        assert called == [], "a stalled decode must not be retried in-process"
