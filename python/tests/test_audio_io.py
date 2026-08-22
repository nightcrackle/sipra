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
from sipra_core.errors import ErrorCode, SipraError

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
