"""Decoding the formats a download actually arrives in.

Every other test in this suite feeds the decoder a WAV, because WAV is
what the fixtures can write with soundfile alone. That left the entire
ffmpeg path — the one every URL import now takes — with no test that ever
handed it a real compressed file. Two releases shipped broken through that
gap: one that could not find the downloaded file, and one before it that
had never decoded anything but WAV.

These build real media with ffmpeg and put it through ``load_audio``
unchanged. They skip where ffmpeg is absent, and run in CI, which has it.
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest

from sipra_core import audio_io
from sipra_core.audio_io import load_audio
from sipra_core.errors import CancelledError, SipraError

pytestmark = pytest.mark.requires_ffmpeg

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not installed")

#: Codec and container pairs yt-dlp realistically produces from YouTube.
#: WebM/Opus is the common case for the best audio stream.
FORMATS = [
    ("aac", "m4a"),
    ("libopus", "opus"),
    ("libopus", "webm"),
    ("libvorbis", "ogg"),
    ("libmp3lame", "mp3"),
    ("flac", "flac"),
]

SECONDS = 4
SOURCE_RATE = 48000


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    """One real file per format, built once."""
    if FFMPEG is None:
        pytest.skip("ffmpeg is not installed")
    directory = tmp_path_factory.mktemp("media")
    built: dict[str, object] = {}
    for codec, container in FORMATS:
        # A bracketed title, because that is what broke the last release.
        target = directory / f"TEETH - Laklak [HQ AUDIO] {codec}.{container}"
        result = subprocess.run(
            [
                FFMPEG, "-v", "error", "-y",
                "-f", "lavfi",
                "-i", f"sine=frequency=440:duration={SECONDS}:sample_rate={SOURCE_RATE}",
                "-ac", "2",
                "-c:a", codec,
                str(target),
            ],
            capture_output=True,
            timeout=120,
            stdin=subprocess.DEVNULL,
        )
        if result.returncode == 0 and target.exists():
            built[f"{codec}.{container}"] = target
    if not built:
        pytest.skip("this ffmpeg build encodes none of the test formats")
    return built


@needs_ffmpeg
class TestDecodingRealFormats:
    @pytest.mark.parametrize("codec,container", FORMATS)
    def test_decodes_to_the_requested_rate(self, media, codec, container):
        path = media.get(f"{codec}.{container}")
        if path is None:
            pytest.skip(f"this ffmpeg cannot encode {codec}")
        buf = load_audio(path, target_sample_rate=44100)
        assert buf.sample_rate == 44100
        assert buf.channels == 2
        # Encoders pad; a couple of hundred milliseconds either way is
        # normal and not what this is testing.
        assert buf.duration == pytest.approx(SECONDS, abs=0.3)

    @pytest.mark.parametrize("codec,container", FORMATS)
    def test_the_audio_survives(self, media, codec, container):
        """A decode that returns silence, or noise, has failed quietly.

        Checked by finding the dominant frequency rather than by measuring
        level: a non-zero peak proves only that bytes arrived, whereas the
        tone being where it was put proves the decode was correct. The
        source is a 440 Hz sine.
        """
        path = media.get(f"{codec}.{container}")
        if path is None:
            pytest.skip(f"this ffmpeg cannot encode {codec}")
        buf = load_audio(path, target_sample_rate=44100)

        assert np.isfinite(buf.data).all()
        assert float(np.max(np.abs(buf.data))) > 0.01, "decoded to near-silence"

        mono = buf.to_mono()
        spectrum = np.abs(np.fft.rfft(mono * np.hanning(mono.size)))
        peak_hz = float(np.fft.rfftfreq(mono.size, 1 / buf.sample_rate)[int(np.argmax(spectrum))])
        assert peak_hz == pytest.approx(440.0, abs=5.0), f"tone landed at {peak_hz:.1f} Hz"

    @pytest.mark.parametrize("codec,container", FORMATS)
    def test_reports_progress_ending_at_one(self, media, codec, container):
        path = media.get(f"{codec}.{container}")
        if path is None:
            pytest.skip(f"this ffmpeg cannot encode {codec}")
        seen: list[float] = []
        load_audio(path, target_sample_rate=44100, on_progress=seen.append)
        assert seen, "a decode that reports nothing looks like one that stopped"
        assert seen == sorted(seen)
        assert seen[-1] == pytest.approx(1.0)
        assert all(0.0 <= value <= 1.0 for value in seen)

    def test_a_bracketed_name_is_no_obstacle(self, media):
        # The 0.9.9 regression was about finding such a file; this checks
        # the decoder is equally indifferent to the name.
        for path in media.values():
            assert "[" in path.name
            assert load_audio(path, target_sample_rate=44100).frames > 0
            break

    def test_webm_is_accepted_by_the_extension_check(self, media):
        """The container YouTube most often hands over."""
        from sipra_core.ingest import local

        path = media.get("libopus.webm")
        if path is None:
            pytest.skip("this ffmpeg cannot encode Opus in WebM")
        info = local.validate_input(path)
        assert info["extension"] == ".webm"


@needs_ffmpeg
class TestDecodingFailsCleanly:
    def test_a_truncated_file_raises_rather_than_hanging(self, media, tmp_path):
        source = next(iter(media.values()))
        broken = tmp_path / "broken.m4a"
        broken.write_bytes(source.read_bytes()[: 1024])
        with pytest.raises(SipraError):
            load_audio(broken, target_sample_rate=44100)

    def test_a_file_of_noise_raises_rather_than_hanging(self, tmp_path):
        junk = tmp_path / "noise.m4a"
        junk.write_bytes(bytes(range(256)) * 200)
        with pytest.raises(SipraError):
            load_audio(junk, target_sample_rate=44100)

    def test_cancellation_stops_a_real_decode(self, media):
        class _Cancelled:
            cancelled = True

        path = next(iter(media.values()))
        with pytest.raises(CancelledError):
            load_audio(path, target_sample_rate=44100, token=_Cancelled())


class TestStallDetection:
    """A decoder that goes quiet is given up on, not waited out.

    The wall-clock ceiling is deliberately generous, because a long decode
    is legitimately long. Producing nothing at all is a different question
    and has a much shorter answer.
    """

    def test_a_silent_decoder_is_given_up_on(self, tmp_path, monkeypatch):
        import sys
        import textwrap

        script = tmp_path / "silent.py"
        script.write_text(
            textwrap.dedent(
                """
                import sys, time
                sys.stdout.buffer.write(b"\\x00" * 16)
                sys.stdout.flush()
                time.sleep(600)
                """
            )
        )
        monkeypatch.setattr(audio_io, "DECODE_STALL_SECONDS", 1)
        with pytest.raises(SipraError) as info:
            audio_io._run_streaming(
                [sys.executable, str(script)],
                expected_bytes=1_000_000,
                timeout=600.0,
                on_progress=None,
                token=None,
                label="stand-in",
            )
        assert "stopped producing output" in str(info.value)
        assert info.value.details["bytesRead"] == 16

    def test_steady_output_is_not_mistaken_for_a_stall(self, tmp_path, monkeypatch):
        import sys
        import textwrap

        script = tmp_path / "steady.py"
        script.write_text(
            textwrap.dedent(
                """
                import sys, time
                for _ in range(6):
                    sys.stdout.buffer.write(b"\\x00" * 4)
                    sys.stdout.flush()
                    time.sleep(0.1)
                """
            )
        )
        monkeypatch.setattr(audio_io, "DECODE_STALL_SECONDS", 2)
        payload, _stderr = audio_io._run_streaming(
            [sys.executable, str(script)],
            expected_bytes=24,
            timeout=60.0,
            on_progress=None,
            token=None,
            label="stand-in",
        )
        assert len(payload) == 24
