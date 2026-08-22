"""End-to-end pipeline tests driven by the fixture engine.

These exercise every step a real separation takes — decode, separate,
write stems, generate peaks, analyse — without a PyTorch install. The
fixture engine's bands sum back to the input exactly, which lets the
reconstruction assertions be strict rather than approximate.
"""

from __future__ import annotations

import numpy as np
import pytest

from sipra_core.audio_io import load_audio
from sipra_core.engines.base import CancellationToken
from sipra_core.engines.registry import EngineRegistry
from sipra_core.engines.testing import FixtureEngine
from sipra_core.errors import CancelledError, ErrorCode, SipraError
from sipra_core.separation import STAGE_WEIGHTS, _StageProgress, separate_track
from sipra_core.stems import FOUR_STEM_SET, SIX_STEM_SET
from sipra_core.waveform import decode_peaks

from .conftest import sine, stereo


@pytest.fixture
def registry() -> EngineRegistry:
    return EngineRegistry([FixtureEngine()])


@pytest.fixture
def source_wav(wav_file):
    mixed = sine(110, 3.0) * 0.4 + sine(880, 3.0) * 0.3 + sine(4000, 3.0) * 0.15
    return wav_file(stereo(mixed.astype(np.float32)), name="input.wav")


class TestStageProgress:
    def test_weights_sum_to_one(self):
        assert sum(weight for _name, weight in STAGE_WEIGHTS) == pytest.approx(1.0)

    def test_maps_stage_fractions_onto_the_overall_bar(self):
        weights = dict(STAGE_WEIGHTS)
        seen: list[float] = []
        progress = _StageProgress(lambda _s, f: seen.append(f))
        progress.report("decode", 1.0)
        progress.report("separate", 0.5)
        assert seen[0] == pytest.approx(weights["decode"])
        assert seen[1] == pytest.approx(weights["decode"] + weights["separate"] * 0.5)

    def test_every_stage_starts_where_the_previous_one_ended(self):
        """No gaps and no overlaps, so the bar cannot jump or stall."""
        progress = _StageProgress(None)
        cursor = 0.0
        for name, weight in STAGE_WEIGHTS:
            base, mapped = progress._offsets[name]
            assert base == pytest.approx(cursor)
            assert mapped == pytest.approx(weight)
            cursor += weight

    def test_the_end_of_separation_is_distinguishable_from_the_start_of_writing(self):
        """The reason ``collect`` exists.

        With separation running straight into stem writing, both boundaries
        landed on the same fraction, so a bar frozen there could mean the
        model was still finishing or that it had finished and the first
        stem was being written. Those are different faults and they must
        not look the same.
        """
        seen: list[tuple[str, float]] = []
        progress = _StageProgress(lambda s, f: seen.append((s, f)))
        progress.report("separate", 1.0)
        progress.report("write", 0.0)
        assert seen[0][1] < seen[1][1]

    def test_never_moves_backwards(self):
        seen: list[float] = []
        progress = _StageProgress(lambda _s, f: seen.append(f))
        progress.report("separate", 0.9)
        progress.report("decode", 0.1)
        assert seen == sorted(seen)

    def test_is_clamped_to_the_unit_interval(self):
        seen: list[float] = []
        progress = _StageProgress(lambda _s, f: seen.append(f))
        progress.report("analyse", 5.0)
        progress.report("decode", -3.0)
        assert all(0.0 <= value <= 1.0 for value in seen)

    def test_a_missing_callback_is_harmless(self):
        _StageProgress(None).report("decode", 0.5)

    def test_a_throwing_callback_cannot_break_a_job(self):
        def explode(_stage: str, _fraction: float) -> None:
            raise RuntimeError("nope")

        _StageProgress(explode).report("decode", 0.5)


class TestSeparateTrack:
    def test_writes_every_stem_and_its_peaks(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "track", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        assert {s.stem_id for s in outcome.stems} == set(FOUR_STEM_SET)
        for artifact in outcome.stems:
            assert artifact.audio_path.exists()
            assert artifact.peaks_path.exists()

    def test_six_stem_model_produces_guitar_and_piano(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-6", analyse=False,
        )
        assert {s.stem_id for s in outcome.stems} == set(SIX_STEM_SET)

    def test_stems_are_returned_in_canonical_display_order(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-6", analyse=False,
        )
        assert [s.stem_id for s in outcome.stems] == list(SIX_STEM_SET)

    def test_writes_a_source_copy_and_its_peaks(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        assert outcome.source_path.exists()
        assert outcome.source_peaks_path.exists()

    def test_every_lane_shares_one_length_and_sample_rate(self, source_wav, tmp_path, registry):
        """Lanes that disagree on length would drift the playhead apart."""
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-6", analyse=False,
        )
        lengths = set()
        rates = set()
        for artifact in outcome.stems:
            buf = load_audio(artifact.audio_path)
            lengths.add(buf.frames)
            rates.add(buf.sample_rate)
        source = load_audio(outcome.source_path)
        assert len(lengths) == 1 and len(rates) == 1
        assert lengths.pop() == source.frames
        assert rates.pop() == outcome.sample_rate

    def test_stems_sum_back_to_the_source(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        summed = sum(load_audio(a.audio_path).data for a in outcome.stems)
        source = load_audio(outcome.source_path).data
        assert np.allclose(summed, source, atol=2e-3)

    def test_peak_files_are_readable_and_match_the_duration(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        peaks = decode_peaks(outcome.stems[0].peaks_path.read_bytes())
        assert peaks.bucket_count > 0
        assert peaks.duration_seconds == pytest.approx(outcome.duration_seconds, abs=0.01)

    def test_reports_per_stem_levels(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        for artifact in outcome.stems:
            payload = artifact.to_dict()
            assert payload["samplePeakDb"] is None or payload["samplePeakDb"] <= 0.1

    def test_a_silent_stem_reports_none_rather_than_negative_infinity(self, wav_file, tmp_path, registry):
        """JSON has no -Infinity; emitting one would break the IPC decode."""
        silent = wav_file(np.zeros((2, 44100), dtype=np.float32), name="silence.wav")
        outcome = separate_track(
            silent, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        payload = outcome.to_dict()
        import json

        json.dumps(payload)  # must not raise
        assert all(s["samplePeakDb"] is None for s in payload["stems"])

    def test_honours_a_stem_subset(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4",
            stems=["vocals", "bass"], analyse=False,
        )
        assert {s.stem_id for s in outcome.stems} == {"vocals", "bass"}

    def test_rejects_a_stem_the_model_cannot_produce(self, source_wav, tmp_path, registry):
        with pytest.raises(SipraError) as info:
            separate_track(
                source_wav, tmp_path / "t", registry=registry,
                engine_id="fixture", model_id="fixture-4",
                stems=["piano"], analyse=False,
            )
        assert info.value.code == ErrorCode.INVALID_PARAMS
        assert "piano" in info.value.message

    def test_runs_analysis_when_asked(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=True,
        )
        assert outcome.analysis is not None
        assert "samplePeakDb" in outcome.analysis

    def test_progress_is_monotonic_and_completes(self, source_wav, tmp_path, registry):
        seen: list[float] = []
        separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
            on_progress=lambda _s, f: seen.append(f),
        )
        assert seen == sorted(seen)
        assert seen[-1] == pytest.approx(1.0)
        assert all(0.0 <= value <= 1.0 for value in seen)

    def test_cancellation_stops_the_job(self, source_wav, tmp_path, registry):
        token = CancellationToken()
        token.cancel()
        with pytest.raises(CancelledError):
            separate_track(
                source_wav, tmp_path / "t", registry=registry,
                engine_id="fixture", model_id="fixture-4", analyse=False, token=token,
            )

    def test_creates_the_output_directory_tree(self, source_wav, tmp_path, registry):
        target = tmp_path / "deep" / "nested" / "track"
        outcome = separate_track(
            source_wav, target, registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        assert (outcome.track_dir / "stems").is_dir()
        assert (outcome.track_dir / "peaks").is_dir()

    def test_missing_input_raises_file_not_found(self, tmp_path, registry):
        with pytest.raises(SipraError) as info:
            separate_track(
                tmp_path / "absent.wav", tmp_path / "t", registry=registry,
                engine_id="fixture", model_id="fixture-4",
            )
        assert info.value.code == ErrorCode.FILE_NOT_FOUND

    def test_serialised_outcome_is_json_safe(self, source_wav, tmp_path, registry):
        import json

        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=True,
        )
        payload = json.loads(json.dumps(outcome.to_dict()))
        assert payload["engineId"] == "fixture"
        assert payload["modelId"] == "fixture-4"
        assert isinstance(payload["stems"], list)
        assert isinstance(payload["warnings"], list)

    def test_engine_warnings_reach_the_outcome(self, source_wav, tmp_path, registry):
        outcome = separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        assert any("not separated" in w for w in outcome.warnings)

    def test_mono_input_is_handled(self, wav_file, tmp_path, registry):
        mono = wav_file(sine(220, 2.0).astype(np.float32), name="mono.wav")
        outcome = separate_track(
            mono, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
        )
        assert len(outcome.stems) == 4


class TestWriteStageProgress:
    """Regression: the bar sat at exactly 80% for the whole write stage.

    80% is the boundary between `separate` and `write` in STAGE_WEIGHTS.
    The loop reported only on completion of each stem, so between
    "separation finished" and "first stem written" — tens of megabytes of
    clipping, transposing and disk I/O on a real track — nothing was
    emitted at all, and the job looked frozen.
    """

    def test_reports_more_than_once_per_stem(self, source_wav, tmp_path, registry):
        seen: list[tuple[str, float]] = []
        separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-4", analyse=False,
            on_progress=lambda stage, fraction: seen.append((stage, fraction)),
        )
        write_reports = [fraction for stage, fraction in seen if stage == "write"]
        # Four stems, reported at the start, mid-point and end of each.
        assert len(write_reports) >= 8

    def test_the_bar_never_jumps_a_whole_stem_during_the_write_stage(
        self, source_wav, tmp_path, registry
    ):
        seen: list[float] = []
        separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-6", analyse=False,
            on_progress=lambda stage, fraction: seen.append(fraction)
            if stage == "write"
            else None,
        )
        gaps = [b - a for a, b in zip(seen, seen[1:], strict=False)]
        # The write stage is 8% of the bar across six stems; no single step
        # should cover a whole stem's worth of it.
        assert gaps, "the write stage reported nothing"
        assert max(gaps) <= 0.08 / 6 + 1e-9

    def test_progress_is_still_monotonic_with_the_extra_reports(
        self, source_wav, tmp_path, registry
    ):
        seen: list[float] = []
        separate_track(
            source_wav, tmp_path / "t", registry=registry,
            engine_id="fixture", model_id="fixture-6", analyse=False,
            on_progress=lambda _stage, fraction: seen.append(fraction),
        )
        assert seen == sorted(seen)
        assert seen[-1] == pytest.approx(1.0)

    def test_stems_are_released_as_they_are_written(self, source_wav, tmp_path, registry):
        """Holding six stems, the source and whatever the engine has not
        freed is enough to push a modest machine into swap, which is what
        turns a slow stage into an apparently frozen one."""
        from sipra_core.engines.testing import FixtureEngine

        captured: dict[str, object] = {}
        original = FixtureEngine.separate

        def spy(self, request, on_progress=None, token=None):
            result = original(self, request, on_progress=on_progress, token=token)
            captured["stems"] = result.stems
            return result

        FixtureEngine.separate = spy
        try:
            outcome = separate_track(
                source_wav, tmp_path / "t", registry=registry,
                engine_id="fixture", model_id="fixture-6", analyse=False,
            )
        finally:
            FixtureEngine.separate = original

        assert len(outcome.stems) == 6
        # Every stem should have been dropped from the engine's result as
        # soon as it reached disk.
        assert captured["stems"] == {}
