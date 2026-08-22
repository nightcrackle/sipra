"""Analysis accuracy checks.

Every assertion here is anchored to a value that can be derived on paper,
not to whatever the implementation happened to produce the first time it
ran. A -20 dBFS sine is -20 dBFS; a 120 BPM click track is 120 BPM; an
Am-Dm-E-Am progression is in A minor.
"""

from __future__ import annotations

import numpy as np
import pytest

from sipra_core.analysis import key as key_mod
from sipra_core.analysis import loudness as loud
from sipra_core.analysis import tempo as tempo_mod
from sipra_core.analysis.analyze import analyse_buffer
from sipra_core.audio_io import AudioBuffer

from .conftest import ANALYSIS_RATE, NOTE, click_track, dbfs_sine, progression, stereo


class TestPeakMeasurement:
    @pytest.mark.parametrize("db", [-0.5, -6.0, -20.0, -40.0])
    def test_sample_peak_matches_the_generated_level(self, db):
        assert loud.sample_peak_db(dbfs_sine(db)) == pytest.approx(db, abs=0.05)

    def test_silence_reads_as_negative_infinity(self):
        assert loud.sample_peak_db(np.zeros((2, 1000), dtype=np.float32)) == float("-inf")

    def test_empty_input_reads_as_negative_infinity(self):
        assert loud.sample_peak_db(np.zeros((2, 0), dtype=np.float32)) == float("-inf")

    def test_true_peak_is_at_least_the_sample_peak(self):
        signal = stereo(dbfs_sine(-6.0, frequency=997.0))
        assert loud.true_peak_db(signal, 44100) >= loud.sample_peak_db(signal) - 0.01

    def test_true_peak_catches_an_inter_sample_overshoot(self):
        """A near-Nyquist alternating signal peaks between samples."""
        alternating = np.tile(np.array([1.0, -1.0], dtype=np.float32), 4000) * 0.98
        signal = alternating[np.newaxis, :]
        assert loud.true_peak_db(signal, 44100) > loud.sample_peak_db(signal)

    def test_true_peak_falls_back_gracefully_on_a_tiny_buffer(self):
        tiny = np.ones((1, 8), dtype=np.float32) * 0.5
        assert loud.true_peak_db(tiny, 44100) == pytest.approx(-6.02, abs=0.05)

    def test_rms_of_a_full_scale_sine_is_minus_three_db(self):
        assert loud.rms_db(dbfs_sine(0.0)) == pytest.approx(-3.01, abs=0.05)

    def test_linear_to_db_floors_instead_of_dividing_by_zero(self):
        assert loud.linear_to_db(0.0) == float("-inf")
        assert loud.linear_to_db(1.0) == pytest.approx(0.0)


class TestIntegratedLoudness:
    def test_mono_reference_tone(self):
        """BS.1770: a -20 dBFS 1 kHz tone in one channel is about -23 LUFS."""
        mono = dbfs_sine(-20.0)[np.newaxis, :]
        assert loud.integrated_loudness(mono, 44100) == pytest.approx(-23.0, abs=0.3)

    def test_stereo_is_about_three_lu_louder_than_mono(self):
        """Summing two identical channels adds 10*log10(2) = 3.01 LU."""
        mono_value = loud.integrated_loudness(dbfs_sine(-20.0)[np.newaxis, :], 44100)
        stereo_value = loud.integrated_loudness(stereo(dbfs_sine(-20.0)), 44100)
        assert stereo_value - mono_value == pytest.approx(3.01, abs=0.1)

    def test_halving_amplitude_lowers_loudness_by_six_lu(self):
        loud_value = loud.integrated_loudness(stereo(dbfs_sine(-14.0)), 44100)
        quiet_value = loud.integrated_loudness(stereo(dbfs_sine(-20.0)), 44100)
        assert loud_value - quiet_value == pytest.approx(6.0, abs=0.15)

    def test_silence_is_unmeasurable(self):
        assert loud.integrated_loudness(np.zeros((2, 44100), dtype=np.float32), 44100) is None

    def test_too_short_to_gate_returns_none(self):
        assert loud.integrated_loudness(stereo(dbfs_sine(-20.0, duration=0.2)), 44100) is None


class TestLoudnessRange:
    def test_a_constant_tone_has_almost_no_range(self):
        value = loud.loudness_range(stereo(dbfs_sine(-20.0, duration=12.0)), 44100)
        assert value is not None and value < 1.0

    def test_a_dynamic_signal_has_a_wide_range(self):
        quiet = dbfs_sine(-40.0, duration=8.0)
        loudpart = dbfs_sine(-12.0, duration=8.0)
        signal = stereo(np.concatenate([quiet, loudpart, quiet]))
        value = loud.loudness_range(signal, 44100)
        assert value is not None and value > 10.0

    def test_too_short_returns_none(self):
        assert loud.loudness_range(stereo(dbfs_sine(-20.0, duration=1.0)), 44100) is None


class TestMeasureReport:
    def test_crest_factor_of_a_sine_is_about_three_db(self):
        stats = loud.measure(stereo(dbfs_sine(-10.0)), 44100)
        assert stats.crest_factor_db == pytest.approx(3.01, abs=0.1)

    def test_report_serialises_with_camel_case_keys(self):
        payload = loud.measure(stereo(dbfs_sine(-14.0)), 44100).to_dict()
        assert set(payload) == {
            "integratedLufs",
            "loudnessRangeLu",
            "samplePeakDb",
            "truePeakDb",
            "rmsDb",
            "crestFactorDb",
        }


class TestTempo:
    @pytest.mark.parametrize("bpm", [90, 120, 140, 174])
    def test_recovers_a_click_track_tempo(self, bpm):
        estimate = tempo_mod.estimate(click_track(bpm), ANALYSIS_RATE)
        assert estimate.bpm == pytest.approx(bpm, abs=1.0)

    def test_a_steady_click_track_reports_high_confidence(self):
        assert tempo_mod.estimate(click_track(120), ANALYSIS_RATE).confidence > 0.7

    def test_silence_yields_no_estimate(self):
        estimate = tempo_mod.estimate(np.zeros(ANALYSIS_RATE * 10, dtype=np.float32), ANALYSIS_RATE)
        assert estimate.bpm is None and estimate.confidence == 0.0

    def test_a_clip_shorter_than_the_minimum_yields_no_estimate(self):
        assert tempo_mod.estimate(click_track(120, duration=1.0), ANALYSIS_RATE).bpm is None

    @pytest.mark.parametrize(
        "value,expected",
        [
            (240.0, 120.0),  # halved once
            (30.0, 60.0),  # doubled once, stops at the lower bound
            (45.0, 90.0),  # doubled once
            (120.0, 120.0),  # already in range, untouched
            (380.0, 190.0),  # halved once, stops at the upper bound
            (1000.0, 125.0),  # halved three times
        ],
    )
    def test_octave_folding_lands_inside_the_musical_range(self, value, expected):
        result = tempo_mod.fold_to_range(value)
        assert result == pytest.approx(expected)
        assert tempo_mod.MIN_BPM <= result <= tempo_mod.MAX_BPM

    @pytest.mark.parametrize("value", [0.0, -5.0, float("inf"), float("nan")])
    def test_octave_folding_passes_through_nonsense_unchanged(self, value):
        result = tempo_mod.fold_to_range(value)
        assert result == value or (np.isnan(value) and np.isnan(result))

    def test_beat_regression_beats_the_median_interval(self):
        """Quantised beat times give a biased median; the fit removes it."""
        period = 0.5
        hop = 512 / 22050
        exact = np.arange(24) * period
        quantised = (np.round(exact / hop) * hop).tolist()
        median_bpm = 60.0 / float(np.median(np.diff(quantised)))
        fitted = tempo_mod.refine_from_beats(quantised)
        assert abs(fitted - 120.0) < abs(median_bpm - 120.0)
        assert fitted == pytest.approx(120.0, abs=0.2)

    def test_beat_regression_needs_enough_beats(self):
        assert tempo_mod.refine_from_beats([0.0, 0.5, 1.0]) is None

    def test_beat_regression_ignores_a_dropped_beat(self):
        beats = [i * 0.5 for i in range(10)] + [7.0, 7.5, 8.0, 8.5]
        assert tempo_mod.refine_from_beats(beats) == pytest.approx(120.0, abs=1.0)

    def test_serialisation_omits_the_beat_grid_unless_asked(self):
        estimate = tempo_mod.TempoEstimate(bpm=128.0, confidence=0.9, beat_times=[0.0, 0.47])
        assert "beatTimes" not in estimate.to_dict()
        assert estimate.to_dict(include_beats=True)["beatTimes"] == [0.0, 0.47]


class TestKey:
    @pytest.mark.parametrize(
        "chords,expected",
        [
            (
                [
                    [NOTE["C4"], NOTE["E4"], NOTE["G4"]],
                    [NOTE["F4"], NOTE["A4"], NOTE["C4"] * 2],
                    [NOTE["G4"], NOTE["B4"], NOTE["D4"] * 2],
                    [NOTE["C4"], NOTE["E4"], NOTE["G4"]],
                ],
                "C major",
            ),
            (
                [
                    [NOTE["A3"], NOTE["C4"], NOTE["E4"]],
                    [NOTE["D3"], NOTE["F3"], NOTE["A3"]],
                    [NOTE["E3"], NOTE["Gs3"], NOTE["B3"]],
                    [NOTE["A3"], NOTE["C4"], NOTE["E4"]],
                ],
                "A minor",
            ),
            (
                [
                    [NOTE["G3"], NOTE["B3"], NOTE["D4"]],
                    [NOTE["C4"], NOTE["E4"], NOTE["G4"]],
                    [NOTE["D4"], NOTE["Fs4"], NOTE["A4"]],
                    [NOTE["G3"], NOTE["B3"], NOTE["D4"]],
                ],
                "G major",
            ),
            (
                [
                    [NOTE["D3"], NOTE["F3"], NOTE["A3"]],
                    [NOTE["G3"], NOTE["Bf3"], NOTE["D4"]],
                    [NOTE["A3"], NOTE["Cs4"], NOTE["E4"]],
                    [NOTE["D3"], NOTE["F3"], NOTE["A3"]],
                ],
                "D minor",
            ),
        ],
    )
    def test_detects_unambiguous_progressions(self, chords, expected):
        estimate = key_mod.estimate(progression(chords), ANALYSIS_RATE)
        assert estimate.label == expected

    def test_camelot_codes_follow_the_wheel(self):
        assert key_mod.camelot_for("C", "major") == "8B"
        assert key_mod.camelot_for("A", "minor") == "8A"
        assert key_mod.camelot_for("G", "major") == "9B"

    def test_a_pure_c_major_chroma_scores_c_major(self):
        chroma = np.zeros(12)
        chroma[[0, 4, 7]] = 1.0
        assert key_mod.detect_from_chroma(chroma).label == "C major"

    def test_a_flat_chroma_is_reported_as_unknown_or_unconfident(self):
        estimate = key_mod.detect_from_chroma(np.ones(12) / 12.0)
        assert estimate.confidence < 0.5

    @pytest.mark.parametrize(
        "bad", [np.zeros(12), np.ones(11), np.full(12, np.nan), np.full(12, -1.0)]
    )
    def test_degenerate_chroma_returns_no_key(self, bad):
        assert key_mod.detect_from_chroma(bad).tonic is None

    def test_an_unknown_profile_name_falls_back_to_the_default(self):
        chroma = np.zeros(12)
        chroma[[0, 4, 7]] = 1.0
        assert key_mod.detect_from_chroma(chroma, "nonsense").label == "C major"

    def test_silence_has_no_key(self):
        assert key_mod.estimate(np.zeros(ANALYSIS_RATE * 3, dtype=np.float32), ANALYSIS_RATE).tonic is None

    def test_relative_keys_are_reported_with_lower_confidence(self):
        """Am-F-C-G shares every pitch class with C major. Whichever way it
        lands, the estimator must not claim certainty it does not have."""
        ambiguous = progression(
            [
                [NOTE["A3"], NOTE["C4"], NOTE["E4"]],
                [NOTE["F3"], NOTE["A3"], NOTE["C4"]],
                [NOTE["C4"], NOTE["E4"], NOTE["G4"]],
                [NOTE["G3"], NOTE["B3"], NOTE["D4"]],
            ]
        )
        unambiguous = progression(
            [
                [NOTE["A3"], NOTE["C4"], NOTE["E4"]],
                [NOTE["D3"], NOTE["F3"], NOTE["A3"]],
                [NOTE["E3"], NOTE["Gs3"], NOTE["B3"]],
                [NOTE["A3"], NOTE["C4"], NOTE["E4"]],
            ]
        )
        assert (
            key_mod.estimate(ambiguous, ANALYSIS_RATE).confidence
            < key_mod.estimate(unambiguous, ANALYSIS_RATE).confidence
        )


class TestAnalyseBuffer:
    def test_reports_every_field_for_a_musical_signal(self, music_like):
        result = analyse_buffer(AudioBuffer(music_like, 44100)).to_dict()
        assert result["durationSeconds"] == pytest.approx(6.0, abs=0.01)
        assert result["channels"] == 2
        assert result["sampleRate"] == 44100
        assert result["bpm"] is not None
        assert result["samplePeakDb"] is not None
        assert result["integratedLufs"] is not None

    def test_progress_is_reported_and_ends_at_one(self, music_like):
        seen: list[tuple[str, float]] = []
        analyse_buffer(AudioBuffer(music_like, 44100), on_progress=lambda s, f: seen.append((s, f)))
        assert seen[-1][1] == pytest.approx(1.0)
        assert {"loudness", "tempo", "key"} <= {stage for stage, _ in seen}

    def test_a_failing_progress_callback_cannot_break_the_analysis(self, music_like):
        def explode(stage: str, fraction: float) -> None:
            raise RuntimeError("progress handler blew up")

        assert analyse_buffer(AudioBuffer(music_like, 44100), on_progress=explode) is not None

    def test_silence_analyses_without_raising(self):
        result = analyse_buffer(AudioBuffer(np.zeros((2, 44100 * 2), dtype=np.float32), 44100))
        payload = result.to_dict()
        assert payload["bpm"] is None
        assert payload["integratedLufs"] is None

    def test_serialisation_shape_is_stable(self, music_like):
        payload = analyse_buffer(AudioBuffer(music_like, 44100)).to_dict()
        for field in (
            "durationSeconds", "sampleRate", "channels", "bpm", "bpmConfidence",
            "key", "scale", "keyLabel", "keyConfidence", "camelot",
            "integratedLufs", "loudnessRangeLu", "samplePeakDb", "truePeakDb",
            "rmsDb", "crestFactorDb",
        ):
            assert field in payload, f"missing {field}"
