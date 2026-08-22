from __future__ import annotations

import numpy as np
import pytest

from sipra_core.errors import SipraError
from sipra_core.waveform import (
    HEADER_SIZE,
    MAGIC,
    compute_peaks,
    decode_peaks,
    encode_peaks,
    write_peaks,
)

from .conftest import sine


class TestComputePeaks:
    def test_bucket_count_rounds_up_so_the_tail_is_kept(self):
        data = np.zeros((1, 1000), dtype=np.float32)
        assert compute_peaks(data, 44100, 256).bucket_count == 4

    def test_exact_multiple_produces_no_extra_bucket(self):
        data = np.zeros((1, 1024), dtype=np.float32)
        assert compute_peaks(data, 44100, 256).bucket_count == 4

    def test_captures_the_extremes_within_each_bucket(self):
        data = np.zeros((1, 512), dtype=np.float32)
        data[0, 10] = 0.75
        data[0, 300] = -0.5
        peaks = compute_peaks(data, 44100, 256)
        assert peaks.maxima[0] == pytest.approx(0.75)
        assert peaks.minima[1] == pytest.approx(-0.5)

    def test_channels_are_averaged(self):
        data = np.stack(
            [np.full(256, 1.0, dtype=np.float32), np.full(256, 0.0, dtype=np.float32)]
        )
        peaks = compute_peaks(data, 44100, 256)
        assert peaks.maxima[0] == pytest.approx(0.5)
        assert peaks.source_channels == 2

    def test_a_full_scale_sine_reaches_both_rails(self):
        peaks = compute_peaks(sine(440, 1.0, 44100)[np.newaxis, :], 44100, 256)
        assert peaks.maxima.max() == pytest.approx(1.0, abs=0.01)
        assert peaks.minima.min() == pytest.approx(-1.0, abs=0.01)

    def test_one_dimensional_input_is_accepted(self):
        assert compute_peaks(np.zeros(512, dtype=np.float32), 44100, 256).bucket_count == 2

    def test_empty_input_yields_an_empty_envelope(self):
        peaks = compute_peaks(np.zeros((2, 0), dtype=np.float32), 44100)
        assert peaks.bucket_count == 0
        assert peaks.duration_seconds == 0.0

    def test_duration_is_derived_from_the_true_frame_count(self):
        peaks = compute_peaks(np.zeros((1, 22050), dtype=np.float32), 44100, 256)
        assert peaks.duration_seconds == pytest.approx(0.5)

    def test_padding_repeats_the_last_sample_rather_than_inserting_silence(self):
        """Zero-padding a fading tail would draw a spike that is not in the audio."""
        data = np.full((1, 300), 0.8, dtype=np.float32)
        peaks = compute_peaks(data, 44100, 256)
        assert peaks.minima[1] == pytest.approx(0.8, abs=1e-4)

    def test_rejects_a_zero_bucket_size(self):
        with pytest.raises(SipraError):
            compute_peaks(np.zeros((1, 10), dtype=np.float32), 44100, 0)

    def test_rejects_three_dimensional_input(self):
        with pytest.raises(SipraError):
            compute_peaks(np.zeros((1, 2, 3), dtype=np.float32), 44100)


class TestPeakSerialisation:
    def test_header_is_exactly_thirty_two_bytes(self):
        payload = encode_peaks(compute_peaks(np.zeros((1, 1024), dtype=np.float32), 44100, 256))
        assert payload[:5] == MAGIC
        assert len(payload) == HEADER_SIZE + 4 * 2 * 2

    def test_round_trip_preserves_metadata_and_shape(self):
        original = compute_peaks(sine(220, 2.0, 48000)[np.newaxis, :], 48000, 512)
        restored = decode_peaks(encode_peaks(original))
        assert restored.sample_rate == 48000
        assert restored.samples_per_bucket == 512
        assert restored.bucket_count == original.bucket_count
        assert restored.duration_seconds == pytest.approx(original.duration_seconds)

    def test_round_trip_is_accurate_to_sixteen_bit_resolution(self):
        original = compute_peaks(sine(220, 1.0, 44100)[np.newaxis, :], 44100, 256)
        restored = decode_peaks(encode_peaks(original))
        assert np.allclose(restored.maxima, original.maxima, atol=1e-4)
        assert np.allclose(restored.minima, original.minima, atol=1e-4)

    def test_values_beyond_full_scale_are_clamped_not_wrapped(self):
        data = np.array([[2.5, -3.0] * 128], dtype=np.float32)
        restored = decode_peaks(encode_peaks(compute_peaks(data, 44100, 256)))
        assert restored.maxima[0] == pytest.approx(1.0, abs=1e-4)
        assert restored.minima[0] == pytest.approx(-1.0, abs=1e-4)

    def test_rejects_a_truncated_header(self):
        with pytest.raises(SipraError, match="shorter than"):
            decode_peaks(b"SPKS1")

    def test_rejects_a_foreign_magic_number(self):
        payload = encode_peaks(compute_peaks(np.zeros((1, 256), dtype=np.float32), 44100))
        with pytest.raises(SipraError, match="Not a Sipra peak file"):
            decode_peaks(b"XXXXX" + payload[5:])

    def test_rejects_a_truncated_body(self):
        payload = encode_peaks(compute_peaks(np.zeros((1, 4096), dtype=np.float32), 44100))
        with pytest.raises(SipraError, match="truncated"):
            decode_peaks(payload[:-8])

    def test_write_peaks_creates_missing_directories(self, tmp_path):
        target = tmp_path / "nested" / "deeper" / "peaks.speaks"
        written = write_peaks(target, compute_peaks(np.zeros((1, 512), dtype=np.float32), 44100))
        assert written.exists()
        assert decode_peaks(written.read_bytes()).bucket_count == 2
