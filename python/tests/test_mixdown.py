from __future__ import annotations

import math

import numpy as np
import pytest
import soundfile as sf

from sipra_core.audio_io import load_audio
from sipra_core.engines.base import CancellationToken
from sipra_core.errors import CancelledError, ErrorCode, SipraError
from sipra_core.mixdown import db_to_gain, export_mix, export_stem_copy, resolve_gains

from .conftest import sine, stereo


@pytest.fixture
def stem_files(tmp_path):
    """Four constant-DC stems, so summing is trivial to verify by hand."""
    paths = {}
    for name, value in (("vocals", 0.1), ("drums", 0.2), ("bass", 0.4), ("other", 0.05)):
        path = tmp_path / f"{name}.wav"
        sf.write(str(path), np.full((44100, 2), value, dtype=np.float32), 44100, subtype="FLOAT")
        paths[name] = str(path)
    return paths


class TestDbToGain:
    @pytest.mark.parametrize(
        "db,gain", [(0.0, 1.0), (-6.02, 0.5), (6.02, 2.0), (-20.0, 0.1)]
    )
    def test_converts_decibels_to_a_linear_ratio(self, db, gain):
        assert db_to_gain(db) == pytest.approx(gain, rel=1e-3)

    @pytest.mark.parametrize("db", [-120.0, -200.0, -math.inf, None, math.nan])
    def test_treats_very_low_and_invalid_values_as_silence(self, db):
        assert db_to_gain(db) == 0.0


class TestResolveGains:
    def test_returns_every_unmuted_stem(self, stem_files):
        resolved = resolve_gains([{"path": p} for p in stem_files.values()])
        assert len(resolved) == 4
        assert all(gain == 1.0 for _path, gain in resolved)

    def test_drops_muted_stems(self, stem_files):
        resolved = resolve_gains(
            [
                {"path": stem_files["vocals"], "muted": True},
                {"path": stem_files["drums"]},
            ]
        )
        assert len(resolved) == 1

    def test_solo_silences_everything_else(self, stem_files):
        resolved = resolve_gains(
            [
                {"path": stem_files["vocals"], "solo": True},
                {"path": stem_files["drums"]},
                {"path": stem_files["bass"]},
            ]
        )
        assert [str(p) for p, _g in resolved] == [stem_files["vocals"]]

    def test_multiple_solos_all_sound(self, stem_files):
        resolved = resolve_gains(
            [
                {"path": stem_files["vocals"], "solo": True},
                {"path": stem_files["drums"], "solo": True},
                {"path": stem_files["bass"]},
            ]
        )
        assert len(resolved) == 2

    def test_mute_beats_solo_on_the_same_stem(self, stem_files):
        """Matches a mixing desk: a soloed-and-muted channel stays down."""
        resolved = resolve_gains(
            [
                {"path": stem_files["vocals"], "solo": True, "muted": True},
                {"path": stem_files["drums"], "solo": True},
            ]
        )
        assert [str(p) for p, _g in resolved] == [stem_files["drums"]]

    def test_applies_a_decibel_gain(self, stem_files):
        resolved = resolve_gains([{"path": stem_files["vocals"], "gainDb": -6.02}])
        assert resolved[0][1] == pytest.approx(0.5, rel=1e-3)

    def test_a_linear_gain_overrides_the_decibel_field(self, stem_files):
        resolved = resolve_gains([{"path": stem_files["vocals"], "gain": 0.25, "gainDb": -6.0}])
        assert resolved[0][1] == pytest.approx(0.25)

    def test_a_zero_gain_stem_is_dropped(self, stem_files):
        with pytest.raises(SipraError):
            resolve_gains([{"path": stem_files["vocals"], "gain": 0.0}])

    def test_an_empty_track_list_raises(self):
        with pytest.raises(SipraError) as info:
            resolve_gains([])
        assert info.value.code == ErrorCode.INVALID_PARAMS

    def test_a_stem_without_a_path_raises(self):
        with pytest.raises(SipraError, match="path"):
            resolve_gains([{"gainDb": 0.0}])

    def test_an_entirely_muted_mix_explains_itself(self, stem_files):
        with pytest.raises(SipraError, match="muted"):
            resolve_gains([{"path": stem_files["vocals"], "muted": True}])


class TestExportMix:
    def test_sums_stems_at_unity(self, stem_files, tmp_path):
        target = tmp_path / "mix.wav"
        export_mix([{"path": p} for p in stem_files.values()], target, bit_depth=32)
        assert load_audio(target).data.mean() == pytest.approx(0.75, abs=1e-4)

    def test_applies_per_stem_gain(self, stem_files, tmp_path):
        target = tmp_path / "mix.wav"
        export_mix(
            [
                {"path": stem_files["vocals"], "gain": 1.0},
                {"path": stem_files["bass"], "gain": 0.5},
            ],
            target,
            bit_depth=32,
        )
        assert load_audio(target).data.mean() == pytest.approx(0.1 + 0.2, abs=1e-4)

    def test_applies_master_gain(self, stem_files, tmp_path):
        target = tmp_path / "mix.wav"
        export_mix(
            [{"path": stem_files["bass"]}], target, bit_depth=32, master_gain_db=-6.02
        )
        assert load_audio(target).data.mean() == pytest.approx(0.2, abs=1e-3)

    def test_honours_solo_and_mute(self, stem_files, tmp_path):
        target = tmp_path / "mix.wav"
        export_mix(
            [
                {"path": stem_files["vocals"], "solo": True},
                {"path": stem_files["bass"]},
            ],
            target,
            bit_depth=32,
        )
        assert load_audio(target).data.mean() == pytest.approx(0.1, abs=1e-4)
        assert load_audio(target).data.mean() != pytest.approx(0.5, abs=1e-4)

    def test_reports_a_useful_summary(self, stem_files, tmp_path):
        result = export_mix([{"path": p} for p in stem_files.values()], tmp_path / "m.wav")
        assert result["sampleRate"] == 44100
        assert result["channels"] == 2
        assert result["stemCount"] == 4
        assert result["durationSeconds"] == pytest.approx(1.0, abs=0.01)
        assert result["format"] == "wav"

    def test_exports_a_time_range(self, stem_files, tmp_path):
        result = export_mix(
            [{"path": stem_files["bass"]}],
            tmp_path / "m.wav",
            start_seconds=0.25,
            end_seconds=0.75,
        )
        assert result["durationSeconds"] == pytest.approx(0.5, abs=0.01)

    def test_rejects_an_empty_range(self, stem_files, tmp_path):
        with pytest.raises(SipraError, match="empty"):
            export_mix(
                [{"path": stem_files["bass"]}],
                tmp_path / "m.wav",
                start_seconds=0.8,
                end_seconds=0.2,
            )

    def test_flags_clipping_on_integer_output(self, tmp_path):
        hot = tmp_path / "hot.wav"
        sf.write(str(hot), np.full((44100, 2), 0.8, dtype=np.float32), 44100, subtype="FLOAT")
        result = export_mix(
            [{"path": str(hot)}, {"path": str(hot)}], tmp_path / "m.wav", bit_depth=24
        )
        assert result["clipped"] is True
        assert float(np.max(np.abs(load_audio(tmp_path / "m.wav").data))) <= 1.0 + 1e-3

    def test_float_output_does_not_clip(self, tmp_path):
        hot = tmp_path / "hot.wav"
        sf.write(str(hot), np.full((44100, 2), 0.8, dtype=np.float32), 44100, subtype="FLOAT")
        result = export_mix(
            [{"path": str(hot)}, {"path": str(hot)}], tmp_path / "m.wav", bit_depth=32
        )
        assert result["clipped"] is False
        assert float(np.max(np.abs(load_audio(tmp_path / "m.wav").data))) > 1.5

    def test_normalising_brings_the_peak_under_the_ceiling(self, tmp_path):
        hot = tmp_path / "hot.wav"
        sf.write(str(hot), stereo(sine(440, 1.0)).T, 44100, subtype="FLOAT")
        result = export_mix(
            [{"path": str(hot)}, {"path": str(hot)}],
            tmp_path / "m.wav",
            bit_depth=32,
            normalise=True,
        )
        assert result["normalised"] is True
        assert result["peakDb"] == pytest.approx(-0.3, abs=0.1)

    def test_pads_stems_of_different_lengths(self, tmp_path):
        long_path = tmp_path / "long.wav"
        short_path = tmp_path / "short.wav"
        sf.write(str(long_path), np.full((44100, 2), 0.2, dtype=np.float32), 44100, subtype="FLOAT")
        sf.write(str(short_path), np.full((22050, 2), 0.2, dtype=np.float32), 44100, subtype="FLOAT")
        result = export_mix(
            [{"path": str(long_path)}, {"path": str(short_path)}],
            tmp_path / "m.wav",
            bit_depth=32,
        )
        assert result["durationSeconds"] == pytest.approx(1.0, abs=0.01)
        data = load_audio(tmp_path / "m.wav").data
        assert data[0, 0] == pytest.approx(0.4, abs=1e-3)
        assert data[0, -1] == pytest.approx(0.2, abs=1e-3)

    def test_broadcasts_a_mono_stem_into_a_stereo_mix(self, tmp_path):
        mono = tmp_path / "mono.wav"
        stereo_path = tmp_path / "stereo.wav"
        sf.write(str(mono), np.full((44100, 1), 0.3, dtype=np.float32), 44100, subtype="FLOAT")
        sf.write(str(stereo_path), np.full((44100, 2), 0.1, dtype=np.float32), 44100, subtype="FLOAT")
        export_mix(
            [{"path": str(mono)}, {"path": str(stereo_path)}], tmp_path / "m.wav", bit_depth=32
        )
        data = load_audio(tmp_path / "m.wav").data
        assert data.shape[0] == 2
        assert np.allclose(data, 0.4, atol=1e-3)

    def test_rejects_mismatched_sample_rates(self, tmp_path):
        a, b = tmp_path / "a.wav", tmp_path / "b.wav"
        sf.write(str(a), np.zeros((44100, 2), dtype=np.float32), 44100)
        sf.write(str(b), np.zeros((48000, 2), dtype=np.float32), 48000)
        with pytest.raises(SipraError, match="sample rates"):
            export_mix([{"path": str(a)}, {"path": str(b)}], tmp_path / "m.wav")

    def test_rejects_an_unknown_format(self, stem_files, tmp_path):
        with pytest.raises(SipraError) as info:
            export_mix([{"path": stem_files["bass"]}], tmp_path / "m.ogg", output_format="ogg")
        assert info.value.code == ErrorCode.INVALID_PARAMS

    def test_rejects_a_bit_depth_the_format_cannot_carry(self, stem_files, tmp_path):
        with pytest.raises(SipraError, match="32-bit"):
            export_mix(
                [{"path": stem_files["bass"]}],
                tmp_path / "m.flac",
                output_format="flac",
                bit_depth=32,
            )

    def test_exports_flac(self, stem_files, tmp_path):
        target = tmp_path / "m.flac"
        result = export_mix(
            [{"path": stem_files["bass"]}], target, output_format="flac", bit_depth=24
        )
        assert target.exists() and result["format"] == "flac"

    def test_missing_stem_raises_file_not_found(self, tmp_path):
        with pytest.raises(SipraError) as info:
            export_mix([{"path": str(tmp_path / "gone.wav")}], tmp_path / "m.wav")
        assert info.value.code == ErrorCode.FILE_NOT_FOUND

    def test_creates_the_output_directory(self, stem_files, tmp_path):
        target = tmp_path / "exports" / "nested" / "m.wav"
        export_mix([{"path": stem_files["bass"]}], target)
        assert target.exists()

    def test_progress_ends_at_one(self, stem_files, tmp_path):
        seen: list[float] = []
        export_mix(
            [{"path": p} for p in stem_files.values()],
            tmp_path / "m.wav",
            on_progress=lambda _s, f: seen.append(f),
        )
        assert seen[-1] == pytest.approx(1.0)

    def test_cancellation_is_honoured(self, stem_files, tmp_path):
        token = CancellationToken()
        token.cancel()
        with pytest.raises(CancelledError):
            export_mix([{"path": p} for p in stem_files.values()], tmp_path / "m.wav", token=token)


class TestExportStemCopy:
    def test_copies_a_stem_to_a_new_location(self, stem_files, tmp_path):
        result = export_stem_copy(stem_files["bass"], tmp_path / "out" / "bass.wav")
        assert (tmp_path / "out" / "bass.wav").exists()
        assert result["sizeBytes"] > 0

    def test_missing_source_raises(self, tmp_path):
        with pytest.raises(SipraError) as info:
            export_stem_copy(tmp_path / "nope.wav", tmp_path / "out.wav")
        assert info.value.code == ErrorCode.FILE_NOT_FOUND
