from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from sipra_core.errors import ErrorCode, SipraError
from sipra_core.ingest import local, youtube

from .conftest import sine, stereo


class TestSafeFilename:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Normal Track.wav", "Normal Track.wav"),
            ("with/slash", "with_slash"),
            ("back\\slash", "back_slash"),
            ('quote"mark', "quote_mark"),
            ("colon:name", "colon_name"),
            ("star*name", "star_name"),
            ("pipe|name", "pipe_name"),
            ("question?name", "question_name"),
            ("less<greater>", "less_greater_"),
            ("  padded  ", "padded"),
            ("trailing dots...", "trailing dots"),
            ("multiple   spaces", "multiple spaces"),
        ],
    )
    def test_strips_characters_windows_rejects(self, raw, expected):
        assert local.safe_filename(raw) == expected

    @pytest.mark.parametrize("reserved", ["CON", "PRN", "AUX", "NUL", "COM1", "LPT9", "con.wav"])
    def test_escapes_reserved_device_names(self, reserved):
        """Windows refuses these regardless of extension."""
        assert local.safe_filename(reserved).startswith("_")

    def test_falls_back_when_nothing_survives(self):
        assert local.safe_filename("///") == "track"
        assert local.safe_filename("") == "track"
        assert local.safe_filename("   ") == "track"
        assert local.safe_filename(None) == "track"

    def test_keeps_a_title_that_is_only_punctuation(self):
        """`!!!` is a real band name; `///` is three stripped separators."""
        assert local.safe_filename("!!!") == "!!!"

    def test_uses_a_custom_fallback(self):
        assert local.safe_filename("", "youtube-audio") == "youtube-audio"

    def test_truncates_an_over_long_name(self):
        assert len(local.safe_filename("x" * 500)) <= local.MAX_STEM_NAME_LENGTH

    def test_truncation_does_not_leave_a_trailing_dot(self):
        name = local.safe_filename(("a" * (local.MAX_STEM_NAME_LENGTH - 1)) + ".b")
        assert not name.endswith(".")

    def test_strips_control_characters(self):
        assert "\x00" not in local.safe_filename("null\x00byte")
        assert "\n" not in local.safe_filename("new\nline")

    def test_keeps_unicode_that_windows_allows(self):
        assert local.safe_filename("Café — Naïve") == "Café — Naïve"


class TestUniquePath:
    def test_returns_the_plain_path_when_free(self, tmp_path):
        assert local.unique_path(tmp_path, "a.wav") == tmp_path / "a.wav"

    def test_appends_a_counter_on_collision(self, tmp_path):
        (tmp_path / "a.wav").write_bytes(b"x")
        assert local.unique_path(tmp_path, "a.wav").name == "a (2).wav"

    def test_keeps_counting_past_the_first_collision(self, tmp_path):
        (tmp_path / "a.wav").write_bytes(b"x")
        (tmp_path / "a (2).wav").write_bytes(b"x")
        assert local.unique_path(tmp_path, "a.wav").name == "a (3).wav"

    def test_preserves_the_extension(self, tmp_path):
        (tmp_path / "song.flac").write_bytes(b"x")
        assert local.unique_path(tmp_path, "song.flac").suffix == ".flac"


class TestValidateInput:
    def test_accepts_a_real_wav(self, wav_file):
        assert local.validate_input(wav_file(stereo(sine(440, 0.5))))["channels"] == 2

    def test_rejects_a_missing_file(self, tmp_path):
        with pytest.raises(SipraError) as info:
            local.validate_input(tmp_path / "gone.wav")
        assert info.value.code == ErrorCode.FILE_NOT_FOUND

    def test_rejects_a_directory(self, tmp_path):
        with pytest.raises(SipraError) as info:
            local.validate_input(tmp_path)
        assert info.value.code == ErrorCode.UNSUPPORTED_FORMAT

    @pytest.mark.parametrize("name", ["notes.txt", "video.mp4", "archive.zip", "noext"])
    def test_rejects_an_unsupported_extension(self, tmp_path, name):
        path = tmp_path / name
        path.write_bytes(b"data")
        with pytest.raises(SipraError) as info:
            local.validate_input(path)
        assert info.value.code == ErrorCode.UNSUPPORTED_FORMAT
        assert "supported" in info.value.details

    def test_rejects_an_empty_file(self, tmp_path):
        path = tmp_path / "empty.wav"
        path.write_bytes(b"")
        with pytest.raises(SipraError) as info:
            local.validate_input(path)
        assert info.value.code == ErrorCode.DECODE_FAILED

    def test_extension_check_is_case_insensitive(self, wav_file):
        path = Path(wav_file(stereo(sine(440, 0.2)), name="LOUD.WAV"))
        assert local.validate_input(path)["extension"] == ".wav"


class TestImportFile:
    def test_copies_into_the_destination(self, wav_file, tmp_path):
        source = wav_file(stereo(sine(440, 0.5)), name="song.wav")
        imported = local.import_file(source, tmp_path / "library")
        assert imported.exists()
        assert imported.parent.name == "library"
        assert imported.read_bytes() == Path(source).read_bytes()

    def test_leaves_the_original_in_place(self, wav_file, tmp_path):
        source = wav_file(stereo(sine(440, 0.3)))
        local.import_file(source, tmp_path / "lib")
        assert Path(source).exists()

    def test_does_not_overwrite_an_existing_import(self, wav_file, tmp_path):
        source = wav_file(stereo(sine(440, 0.3)), name="dup.wav")
        first = local.import_file(source, tmp_path / "lib")
        second = local.import_file(source, tmp_path / "lib")
        assert first != second
        assert first.exists() and second.exists()

    def test_creates_the_destination_directory(self, wav_file, tmp_path):
        source = wav_file(stereo(sine(440, 0.2)))
        assert local.import_file(source, tmp_path / "deep" / "nested").exists()


class TestFingerprint:
    def test_is_stable_for_the_same_content(self, wav_file):
        path = wav_file(stereo(sine(440, 0.5)))
        assert local.file_fingerprint(path) == local.file_fingerprint(path)

    def test_differs_for_different_content(self, wav_file):
        a = wav_file(stereo(sine(440, 0.5)), name="a.wav")
        b = wav_file(stereo(sine(880, 0.5)), name="b.wav")
        assert local.file_fingerprint(a) != local.file_fingerprint(b)

    def test_differs_when_only_the_length_differs(self, wav_file):
        a = wav_file(stereo(sine(440, 0.5)), name="short.wav")
        b = wav_file(stereo(sine(440, 1.0)), name="long.wav")
        assert local.file_fingerprint(a) != local.file_fingerprint(b)

    def test_handles_a_file_smaller_than_one_chunk(self, tmp_path):
        path = tmp_path / "tiny.wav"
        path.write_bytes(b"12345")
        assert len(local.file_fingerprint(path)) == 64


class _FakeProc:
    """Stand-in for a finished subprocess."""

    def __init__(self, returncode=0, stdout=b"", stderr=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def fake_ytdlp(monkeypatch, tmp_path, *, version=_FakeProc(0, b"2025.01.01"), request=None):
    """Install a fake yt-dlp whose responses depend on the arguments.

    The preflight `--version` call and the real request have to be
    distinguishable, or a test that wants to exercise one ends up
    exercising the other.
    """
    fake = tmp_path / "yt-dlp"
    fake.write_text("#!/bin/sh\n")
    monkeypatch.setenv("SIPRA_YTDLP", str(fake))

    def _run(args, **_kwargs):
        if "--version" in args:
            return version
        return request if request is not None else _FakeProc(0, b"{}")

    monkeypatch.setattr(subprocess, "run", _run)
    return fake


@pytest.fixture(autouse=True)
def _clear_ytdlp_cache():
    """The preflight version check is cached; tests must not inherit it."""
    youtube.reset_ready_cache()
    yield
    youtube.reset_ready_cache()


class TestYoutubeUrlValidation:
    @pytest.mark.parametrize(
        "url",
        [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
        ],
    )
    def test_accepts_allowlisted_hosts(self, url):
        assert youtube.is_supported_url(url) is True

    @pytest.mark.parametrize(
        "url",
        [
            "https://vimeo.com/12345",
            "https://soundcloud.com/track",
            "https://evil.com/youtube.com/watch",
            "https://notyoutube.com/watch",
            "https://youtube.com.attacker.net/watch",
            "ftp://youtube.com/watch",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "",
            "   ",
            "not a url",
        ],
    )
    def test_rejects_everything_else(self, url):
        assert youtube.is_supported_url(url) is False

    def test_rejects_non_string_input(self):
        assert youtube.is_supported_url(None) is False
        assert youtube.is_supported_url(12345) is False

    def test_a_lookalike_subdomain_is_not_accepted(self):
        """`youtube.com.attacker.net` must not pass a substring check."""
        assert youtube.is_supported_url("https://youtube.com.attacker.net/watch?v=x") is False


class TestYoutubeRightsGate:
    def test_download_refuses_without_confirmation(self, tmp_path):
        with pytest.raises(SipraError) as info:
            youtube.download_audio(
                "https://youtube.com/watch?v=dQw4w9WgXcQ", tmp_path, rights_confirmed=False
            )
        assert info.value.code == ErrorCode.RIGHTS_NOT_CONFIRMED

    def test_the_gate_is_checked_before_the_url_is_validated(self, tmp_path):
        """The confirmation must not be bypassable by sending a bad URL."""
        with pytest.raises(SipraError) as info:
            youtube.download_audio("https://vimeo.com/1", tmp_path, rights_confirmed=False)
        assert info.value.code == ErrorCode.RIGHTS_NOT_CONFIRMED

    def test_download_rejects_a_disallowed_host_once_confirmed(self, tmp_path):
        with pytest.raises(SipraError) as info:
            youtube.download_audio("https://vimeo.com/1", tmp_path, rights_confirmed=True)
        assert info.value.code == ErrorCode.UNSUPPORTED_URL

    def test_reports_when_the_downloader_is_absent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(youtube, "ytdlp_path", lambda: None)
        with pytest.raises(SipraError) as info:
            youtube.download_audio(
                "https://youtube.com/watch?v=dQw4w9WgXcQ", tmp_path, rights_confirmed=True
            )
        assert info.value.code == ErrorCode.DOWNLOADER_UNAVAILABLE


class TestYoutubeDownloaderDiscovery:
    def test_prefers_an_explicit_override(self, tmp_path, monkeypatch):
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))
        assert youtube.ytdlp_path() == str(fake)

    def test_ignores_an_override_that_does_not_exist(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SIPRA_YTDLP", str(tmp_path / "missing"))
        monkeypatch.setenv("SIPRA_BIN_DIR", str(tmp_path / "also-missing"))
        monkeypatch.setattr("shutil.which", lambda _name: None)
        assert youtube.ytdlp_path() is None

    def test_finds_a_bundled_binary(self, tmp_path, monkeypatch):
        import sys

        monkeypatch.delenv("SIPRA_YTDLP", raising=False)
        name = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"
        (tmp_path / name).write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_BIN_DIR", str(tmp_path))
        assert youtube.ytdlp_path() == str(tmp_path / name)


class TestYoutubeMetadata:
    def test_rejects_a_disallowed_host_before_spawning_anything(self, monkeypatch):
        def explode(*args, **kwargs):  # pragma: no cover
            raise AssertionError("yt-dlp must not be invoked for a rejected URL")

        monkeypatch.setattr(subprocess, "run", explode)
        with pytest.raises(SipraError) as info:
            youtube.fetch_metadata("https://vimeo.com/1")
        assert info.value.code == ErrorCode.UNSUPPORTED_URL

    def test_parses_a_successful_response(self, monkeypatch, tmp_path):
        fake_ytdlp(
            monkeypatch,
            tmp_path,
            request=_FakeProc(
                0,
                b'{"title":"A Song","duration":210,"uploader":"Band",'
                b'"webpage_url":"https://youtu.be/dQw4w9WgXcQ"}',
            ),
        )
        meta = youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")
        assert meta == {
            "title": "A Song",
            "durationSeconds": 210,
            "uploader": "Band",
            "sourceUrl": "https://youtu.be/dQw4w9WgXcQ",
        }

    def test_surfaces_a_downloader_failure(self, monkeypatch, tmp_path):
        fake_ytdlp(
            monkeypatch, tmp_path, request=_FakeProc(1, b"", b"ERROR: Video unavailable")
        )
        with pytest.raises(SipraError) as info:
            youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")
        assert info.value.code == ErrorCode.DOWNLOAD_FAILED
        assert "Video unavailable" in info.value.details["stderr"]
        # The message shown to the user is explanatory, not raw stderr.
        assert "unavailable" in info.value.message.lower()

    def test_rejects_unparseable_metadata(self, monkeypatch, tmp_path):
        fake_ytdlp(monkeypatch, tmp_path, request=_FakeProc(0, b"not json at all"))
        with pytest.raises(SipraError):
            youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")


class TestYoutubeDurationLimit:
    def test_refuses_a_recording_over_the_limit(self, monkeypatch, tmp_path):
        fake_ytdlp(monkeypatch, tmp_path)
        monkeypatch.setattr(
            youtube,
            "fetch_metadata",
            lambda _url: {
                "title": "Six Hour Set",
                "durationSeconds": 6 * 3600,
                "uploader": "DJ",
                "sourceUrl": "https://youtu.be/dQw4w9WgXcQ",
            },
        )
        with pytest.raises(SipraError) as info:
            youtube.download_audio(
                "https://youtu.be/dQw4w9WgXcQ", tmp_path, rights_confirmed=True
            )
        assert info.value.code == ErrorCode.DOWNLOAD_FAILED
        assert "20 minute" in info.value.message


class TestLocateOutput:
    def test_finds_the_exact_file(self, tmp_path):
        target = tmp_path / "song.wav"
        target.write_bytes(b"x")
        assert youtube._locate_output(target) == target

    def test_accepts_a_different_extension(self, tmp_path):
        (tmp_path / "song.m4a").write_bytes(b"x")
        found = youtube._locate_output(tmp_path / "song.wav")
        assert found is not None and found.suffix == ".m4a"

    def test_ignores_partial_downloads(self, tmp_path):
        (tmp_path / "song.part").write_bytes(b"x")
        assert youtube._locate_output(tmp_path / "song.wav") is None

    def test_returns_none_when_nothing_was_written(self, tmp_path):
        assert youtube._locate_output(tmp_path / "song.wav") is None


class TestVideoIdExtraction:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ],
    )
    def test_extracts_the_id(self, url, expected):
        assert youtube.video_id_of(url) == expected

    @pytest.mark.parametrize(
        "url",
        [
            # A link truncated on its way through a chat client.
            "https://www.youtube.com/watch?v=",
            "https://www.youtube.com/watch",
            "https://youtu.be/",
            "https://www.youtube.com/",
            "https://www.youtube.com/watch?v=tooshort",
            "https://www.youtube.com/watch?v=waaaaaaaaaytoolong",
            "https://vimeo.com/watch?v=dQw4w9WgXcQ",
            "not a url",
            "",
            None,
        ],
    )
    def test_returns_none_when_there_is_no_usable_id(self, url):
        assert youtube.video_id_of(url) is None

    def test_an_incomplete_link_is_rejected_before_anything_is_spawned(self, monkeypatch):
        """The bug this covers: a link with no video id was handed to yt-dlp,
        which then sat there until the timeout fired and reported nothing
        useful."""

        def explode(*args, **kwargs):  # pragma: no cover - must not run
            raise AssertionError("yt-dlp must not be invoked for an id-less link")

        monkeypatch.setattr(subprocess, "run", explode)
        with pytest.raises(SipraError) as info:
            youtube.fetch_metadata("https://www.youtube.com/watch?v=")
        assert info.value.code == ErrorCode.UNSUPPORTED_URL
        assert "no video in it" in info.value.message


class TestYoutubeTimeouts:
    def test_a_timeout_becomes_an_explained_error_not_a_raw_traceback(
        self, monkeypatch, tmp_path
    ):
        """Regression: `subprocess.TimeoutExpired` escaped uncaught and
        surfaced to the user as `Unexpected failure: Command [...] timed out
        after 60 seconds`, which names no cause and suggests no remedy."""
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))

        def _run(args, **kwargs):
            if "--version" in args:
                return _FakeProc(0, b"2025.01.01")
            raise subprocess.TimeoutExpired(cmd=args, timeout=kwargs.get("timeout", 120))

        monkeypatch.setattr(subprocess, "run", _run)

        with pytest.raises(SipraError) as info:
            youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")

        error = info.value
        assert error.code == ErrorCode.DOWNLOAD_FAILED
        assert "did not respond" in error.message
        assert "reading that link" in error.message
        # And it must suggest something the user can actually try.
        assert error.details["hints"]
        assert any("online" in hint for hint in error.details["hints"])

    def test_a_timeout_during_the_preflight_is_also_explained(self, monkeypatch, tmp_path):
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))

        def _run(args, **kwargs):
            raise subprocess.TimeoutExpired(cmd=args, timeout=180)

        monkeypatch.setattr(subprocess, "run", _run)
        with pytest.raises(SipraError) as info:
            youtube.ensure_ready()
        assert "starting up" in info.value.message

    def test_a_binary_that_will_not_start_is_reported_clearly(self, monkeypatch, tmp_path):
        fake_ytdlp(monkeypatch, tmp_path, version=_FakeProc(1, b"", b"not a valid win32 app"))
        with pytest.raises(SipraError) as info:
            youtube.ensure_ready()
        assert info.value.code == ErrorCode.DOWNLOADER_UNAVAILABLE
        assert "would not run" in info.value.message

    def test_an_os_error_starting_the_binary_is_reported_clearly(self, monkeypatch, tmp_path):
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))
        monkeypatch.setattr(
            subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("Exec format error"))
        )
        with pytest.raises(SipraError) as info:
            youtube.ensure_ready()
        assert info.value.code == ErrorCode.DOWNLOADER_UNAVAILABLE

    def test_the_preflight_runs_once_and_is_cached(self, monkeypatch, tmp_path):
        """The unpack cost of a PyInstaller bundle should be paid once, not
        on every request."""
        calls: list[list[str]] = []
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))

        def _run(args, **_kwargs):
            calls.append(list(args))
            if "--version" in args:
                return _FakeProc(0, b"2025.01.01")
            return _FakeProc(0, b'{"title":"x"}')

        monkeypatch.setattr(subprocess, "run", _run)

        youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")
        youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")

        version_calls = [call for call in calls if "--version" in call]
        assert len(version_calls) == 1

    def test_timeouts_can_be_raised_from_the_environment(self, monkeypatch):
        monkeypatch.setenv("SIPRA_YTDLP_METADATA_TIMEOUT", "300")
        assert youtube._timeout_from_env("SIPRA_YTDLP_METADATA_TIMEOUT", 120) == 300

    @pytest.mark.parametrize("bad", ["", "nonsense", "0", "-5"])
    def test_an_unusable_timeout_override_falls_back_to_the_default(self, monkeypatch, bad):
        monkeypatch.setenv("SIPRA_YTDLP_METADATA_TIMEOUT", bad)
        assert youtube._timeout_from_env("SIPRA_YTDLP_METADATA_TIMEOUT", 120) == 120


class TestNetworkHardening:
    def test_socket_timeout_and_retries_are_always_passed(self):
        """Without these yt-dlp waits on a half-open socket until our own
        timeout fires, which hides the real cause."""
        args = youtube._network_args()
        assert "--socket-timeout" in args
        assert str(youtube.SOCKET_TIMEOUT_SECONDS) in args
        assert "--retries" in args

    def test_ipv4_is_not_forced_by_default(self, monkeypatch):
        monkeypatch.delenv("SIPRA_YTDLP_FORCE_IPV4", raising=False)
        assert "-4" not in youtube._network_args()

    def test_ipv4_can_be_forced_for_a_broken_ipv6_stack(self, monkeypatch):
        monkeypatch.setenv("SIPRA_YTDLP_FORCE_IPV4", "1")
        assert "-4" in youtube._network_args()

    def test_the_hardening_flags_reach_the_process(self, monkeypatch, tmp_path):
        seen: list[list[str]] = []
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))

        def _run(args, **_kwargs):
            seen.append(list(args))
            if "--version" in args:
                return _FakeProc(0, b"2025.01.01")
            return _FakeProc(0, b'{"title":"x"}')

        monkeypatch.setattr(subprocess, "run", _run)
        youtube.fetch_metadata("https://youtu.be/dQw4w9WgXcQ")

        metadata_call = [call for call in seen if "--dump-single-json" in call][0]
        assert "--socket-timeout" in metadata_call


class TestFailureExplanations:
    @pytest.mark.parametrize(
        "stderr,expected",
        [
            ("ERROR: Private video. Sign in", "private"),
            ("ERROR: Video unavailable", "unavailable"),
            ("Sign in to confirm your age", "age-restricted"),
            ("ERROR: unable to download webpage", "reach youtube"),
            ("HTTP Error 429: Too Many Requests", "rate-limit"),
            ("ERROR: Unsupported URL", "did not recognise"),
        ],
    )
    def test_translates_the_failures_people_actually_hit(self, stderr, expected):
        assert expected in youtube._explain_ytdlp_failure(stderr).lower()

    def test_falls_back_without_pretending_to_know(self):
        message = youtube._explain_ytdlp_failure("something entirely novel")
        assert "yt-dlp" in message


class TestDiagnose:
    def test_reports_a_missing_downloader(self, monkeypatch):
        monkeypatch.delenv("SIPRA_YTDLP", raising=False)
        monkeypatch.delenv("SIPRA_BIN_DIR", raising=False)
        monkeypatch.setattr("shutil.which", lambda _name: None)
        report = youtube.diagnose()
        assert report["available"] is False
        assert report["error"]

    def test_reports_a_healthy_downloader(self, monkeypatch, tmp_path):
        fake_ytdlp(monkeypatch, tmp_path, request=_FakeProc(0, b"dQw4w9WgXcQ\n"))
        report = youtube.diagnose()
        assert report["available"] is True
        assert report["version"] == "2025.01.01"
        assert report["canReachYoutube"] is True
        assert report["error"] is None

    def test_reports_a_downloader_that_cannot_reach_youtube(self, monkeypatch, tmp_path):
        fake_ytdlp(
            monkeypatch,
            tmp_path,
            request=_FakeProc(1, b"", b"ERROR: unable to download webpage"),
        )
        report = youtube.diagnose()
        assert report["available"] is True
        assert report["canReachYoutube"] is False
        assert report["hints"]

    def test_reports_the_timeouts_in_force(self, monkeypatch, tmp_path):
        fake_ytdlp(monkeypatch, tmp_path, request=_FakeProc(0, b"dQw4w9WgXcQ\n"))
        report = youtube.diagnose()
        assert report["timeouts"]["metadataSeconds"] > 60


# A stand-in for yt-dlp. Answers --version, --dump-single-json and a real
# download, and can be told to flood stderr.
_FAKE_YTDLP = '''#!{python}
import json, os, re, sys, time

args = sys.argv[1:]

if "--version" in args:
    print("2025.01.01")
    sys.exit(0)

if "--dump-single-json" in args:
    print(json.dumps({{
        "title": "Fake Track",
        "duration": 12,
        "uploader": "Nobody",
        "webpage_url": args[-1],
    }}))
    sys.exit(0)

# Download. Optionally flood stderr first.
flood = int(os.environ.get("FAKE_STDERR_BYTES", "0"))
if flood:
    written = 0
    while written < flood:
        line = "WARNING: something noisy happened " + "x" * 100
        print(line, file=sys.stderr)
        written += len(line) + 1
    sys.stderr.flush()

for percent in (0.0, 25.0, 50.0, 75.0, 100.0):
    print("[download] {{:5.1f}}% of 1.00MiB".format(percent))
    sys.stdout.flush()

output = args[args.index("--output") + 1]
target = re.sub(r"\\.%\\(ext\\)s$", ".wav", output)
os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
with open(target, "wb") as handle:
    handle.write(b"RIFF____WAVEfmt ")
sys.exit(0)
'''


def install_fake_ytdlp(monkeypatch, tmp_path, stderr_bytes: int = 0):
    """Write an executable fake yt-dlp and point Sipra at it."""
    import stat
    import sys as _sys

    script = tmp_path / "fake-yt-dlp.py"
    script.write_text(_FAKE_YTDLP.format(python=_sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("SIPRA_YTDLP", str(script))
    monkeypatch.setenv("FAKE_STDERR_BYTES", str(stderr_bytes))
    return script


@pytest.mark.skipif(
    __import__("sys").platform == "win32",
    reason="the fake downloader relies on a shebang",
)
class TestDownloadAgainstAFakeDownloader:
    def test_downloads_and_reports_progress_through_every_phase(self, monkeypatch, tmp_path):
        install_fake_ytdlp(monkeypatch, tmp_path)
        seen: list[tuple[str, float]] = []

        media = youtube.download_audio(
            "https://youtu.be/dQw4w9WgXcQ",
            tmp_path / "out",
            rights_confirmed=True,
            on_progress=lambda stage, fraction: seen.append((stage, fraction)),
        )

        assert media.path.exists()
        assert media.title == "Fake Track"

        stages = [stage for stage, _fraction in seen]
        # The phases before the transfer used to be silent, which left the
        # job sitting at 0% for as long as they took.
        assert "prepare" in stages
        assert "metadata" in stages
        assert "download" in stages
        assert seen[-1] == ("download", 1.0)

    def test_progress_is_reported_before_the_transfer_starts(self, monkeypatch, tmp_path):
        install_fake_ytdlp(monkeypatch, tmp_path)
        seen: list[str] = []
        youtube.download_audio(
            "https://youtu.be/dQw4w9WgXcQ",
            tmp_path / "out",
            rights_confirmed=True,
            on_progress=lambda stage, _fraction: seen.append(stage),
        )
        assert seen[0] == "prepare"
        assert seen.index("metadata") < seen.index("download")

    def test_a_downloader_that_floods_stderr_does_not_deadlock(self, monkeypatch, tmp_path):
        """Regression: stdout was read to EOF while stderr sat unread. Once
        yt-dlp had written a pipe buffer's worth of warnings it blocked,
        and it blocked while we were blocked reading stdout — a permanent
        hang that no timeout could break, because the wait() carrying the
        timeout was never reached."""
        install_fake_ytdlp(monkeypatch, tmp_path, stderr_bytes=512 * 1024)

        media = youtube.download_audio(
            "https://youtu.be/dQw4w9WgXcQ",
            tmp_path / "out",
            rights_confirmed=True,
        )
        assert media.path.exists()

    def test_a_failing_progress_callback_cannot_sink_the_download(self, monkeypatch, tmp_path):
        install_fake_ytdlp(monkeypatch, tmp_path)

        def explode(_stage: str, _fraction: float) -> None:
            raise RuntimeError("progress handler blew up")

        media = youtube.download_audio(
            "https://youtu.be/dQw4w9WgXcQ",
            tmp_path / "out",
            rights_confirmed=True,
            on_progress=explode,
        )
        assert media.path.exists()


class TestChildProcessIsolation:
    """Every process Sipra spawns must be cut off from the sidecar's stdin.

    Ours is the NDJSON protocol pipe from Electron. A child that reads it
    steals bytes meant for the sidecar; a child that blocks on it waits
    forever for input that is never coming. yt-dlp spawns ffmpeg, which
    reads stdin for keyboard commands unless told otherwise, so the
    inheritance reaches two processes deep.
    """

    def test_no_spawn_anywhere_in_the_package_inherits_stdin(self):
        import re
        from pathlib import Path

        import sipra_core

        root = Path(sipra_core.__file__).parent
        offenders: list[str] = []

        for source in root.rglob("*.py"):
            text = source.read_text(encoding="utf-8")
            for match in re.finditer(r"subprocess\.(run|Popen)\(", text):
                # Take the call's argument list by balancing brackets.
                start = match.end()
                depth = 1
                index = start
                while index < len(text) and depth:
                    if text[index] == "(":
                        depth += 1
                    elif text[index] == ")":
                        depth -= 1
                    index += 1
                call = text[start:index]
                if "stdin=" not in call:
                    line = text[: match.start()].count("\n") + 1
                    offenders.append(f"{source.relative_to(root)}:{line}")

        assert not offenders, (
            "these spawns inherit the sidecar's stdin: " + ", ".join(offenders)
        )


class TestEverySubprocessCanEnd:
    """No spawn anywhere in the package may be able to wait forever.

    This test exists because of how the same bug was fixed twice. A yt-dlp
    call with no timeout hung an import; the timeout was added to
    ``ingest/youtube.py`` and the identical defect sat untouched in
    ``audio_io.py`` until an ffmpeg decode hung an import in exactly the
    same way, months of releases later. Fixing the file that was reported
    is not the same as fixing the fault.

    ``subprocess.run`` carries its own deadline, so it must pass one.
    ``Popen`` has none, so a file that uses it must manage a deadline
    itself — and is listed here, so adding a new one is a deliberate act
    rather than an oversight.
    """

    #: Files that drive a Popen against a deadline of their own making.
    #: Each reads output incrementally, which `run` cannot do, and each is
    #: checked below for an actual deadline.
    POPEN_OWNERS = {"audio_io.py", "ingest/youtube.py"}

    def _calls(self, text: str, pattern: str):
        """Yield (line number, argument text) for each matching call."""
        import re

        for match in re.finditer(pattern, text):
            start = match.end()
            depth = 1
            index = start
            while index < len(text) and depth:
                if text[index] == "(":
                    depth += 1
                elif text[index] == ")":
                    depth -= 1
                index += 1
            yield text[: match.start()].count("\n") + 1, text[start:index]

    def _sources(self):
        from pathlib import Path

        import sipra_core

        root = Path(sipra_core.__file__).parent
        for source in sorted(root.rglob("*.py")):
            yield source.relative_to(root).as_posix(), source.read_text(encoding="utf-8")

    def test_every_subprocess_run_carries_a_timeout(self):
        offenders = [
            f"{name}:{line}"
            for name, text in self._sources()
            for line, call in self._calls(text, r"subprocess\.run\(")
            if "timeout=" not in call
        ]
        assert not offenders, (
            "these calls can wait forever: " + ", ".join(offenders)
        )

    def test_only_declared_files_use_popen(self):
        users = {
            name
            for name, text in self._sources()
            for _line, _call in self._calls(text, r"subprocess\.Popen\(")
        }
        undeclared = users - self.POPEN_OWNERS
        assert not undeclared, (
            "these files spawn a Popen without declaring how it ends: "
            + ", ".join(sorted(undeclared))
        )

    def test_every_popen_file_enforces_a_deadline(self):
        missing = []
        for name, text in self._sources():
            if name not in self.POPEN_OWNERS:
                continue
            has_wait = "wait(timeout=" in text or "communicate(timeout=" in text
            has_clock = "time.monotonic()" in text
            if not (has_wait and has_clock):
                missing.append(name)
        assert not missing, (
            "these files own a Popen but do not bound it: " + ", ".join(missing)
        )

    def test_the_declared_list_has_no_stale_entries(self):
        # A file that stops using Popen should leave the list, or the list
        # stops meaning anything.
        users = {
            name
            for name, text in self._sources()
            for _line, _call in self._calls(text, r"subprocess\.Popen\(")
        }
        assert users >= self.POPEN_OWNERS, (
            "declared but no longer using Popen: "
            + ", ".join(sorted(self.POPEN_OWNERS - users))
        )


_STDIN_READER = '''#!{python}
import sys
if "--version" in sys.argv:
    # Block on stdin before answering. With stdin inherited from the
    # sidecar this never returns; with DEVNULL it reads EOF at once.
    sys.stdin.read()
    print("2025.01.01")
    sys.exit(0)
sys.stdin.read()
print("[download] 100.0% of 1.00MiB")
sys.exit(0)
'''


@pytest.mark.skipif(
    __import__("sys").platform == "win32",
    reason="the fake downloader relies on a shebang",
)
def test_a_downloader_that_reads_stdin_still_completes(monkeypatch, tmp_path):
    """Regression: the preflight hung on `yt-dlp --version`.

    Whatever the arguments were, the first invocation of the binary was
    where it stopped — which pointed at how it was spawned rather than at
    what it was asked to do.
    """
    import stat
    import sys as _sys

    script = tmp_path / "stdin-reader.py"
    script.write_text(_STDIN_READER.format(python=_sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("SIPRA_YTDLP", str(script))
    youtube.reset_ready_cache()

    # Would hang forever if stdin were inherited from a pipe with no writer.
    assert youtube.ensure_ready() == "2025.01.01"


class TestDeterministicInvocation:
    def test_a_user_config_file_cannot_change_what_sipra_runs(self):
        """A yt-dlp.conf anywhere on the machine is read by default."""
        assert "--ignore-config" in youtube._network_args()

    def test_the_preflight_also_ignores_config(self, monkeypatch, tmp_path):
        seen: list[list[str]] = []
        fake = tmp_path / "yt-dlp"
        fake.write_text("#!/bin/sh\n")
        monkeypatch.setenv("SIPRA_YTDLP", str(fake))

        def _run(args, **_kwargs):
            seen.append(list(args))
            return _FakeProc(0, b"2025.01.01")

        monkeypatch.setattr(subprocess, "run", _run)
        youtube.ensure_ready()
        assert "--ignore-config" in seen[0]


class TestDownloadFormat:
    """What the downloader asks for.

    It used to force `--audio-format wav`, which makes yt-dlp run a second
    full ffmpeg pass expanding a few megabytes of compressed audio into
    hundreds of megabytes of PCM — a file Sipra then decodes and deletes.
    The import that appeared to stall while "Reading the file" was reading
    the product of that conversion.
    """

    def test_does_not_force_a_wav_conversion(self):
        import inspect

        from sipra_core.ingest import youtube

        source = inspect.getsource(youtube.download_audio)
        assert '"--audio-format", "wav"' not in source
        assert '"--extract-audio"' in source

    def test_reserves_the_whole_stem_because_the_extension_is_unknown(self, tmp_path):
        from sipra_core.ingest.local import unique_stem

        (tmp_path / "Song.opus").write_bytes(b"x")
        chosen = unique_stem(tmp_path, "Song", ".audio")
        # Not "Song.audio": a leftover Song.opus would be found by the glob
        # that locates the download afterwards.
        assert chosen.stem != "Song"
        assert chosen.suffix == ".audio"

    def test_a_free_stem_is_used_as_is(self, tmp_path):
        from sipra_core.ingest.local import unique_stem

        assert unique_stem(tmp_path, "Song", ".audio").name == "Song.audio"

    def test_successive_reservations_do_not_collide(self, tmp_path):
        from sipra_core.ingest.local import unique_stem

        first = unique_stem(tmp_path, "Song", ".audio")
        first.write_bytes(b"x")
        second = unique_stem(tmp_path, "Song", ".audio")
        assert second != first
        second.write_bytes(b"x")
        assert unique_stem(tmp_path, "Song", ".audio") not in (first, second)

    def test_a_suffix_without_a_dot_is_accepted(self, tmp_path):
        from sipra_core.ingest.local import unique_stem

        assert unique_stem(tmp_path, "Song", "audio").suffix == ".audio"

    def test_the_download_polls_rather_than_blocking_on_output(self):
        """The deadline has to be reachable.

        Reading stdout inline meant the timeout lived on the wait() after
        the loop, and the loop only ends when yt-dlp closes stdout. A
        download that goes quiet without exiting blocked in the read and
        never reached the timeout meant to catch exactly that.
        """
        import inspect

        from sipra_core.ingest import youtube

        source = inspect.getsource(youtube.download_audio)
        assert "DOWNLOAD_POLL_SECONDS" in source
        assert "time.monotonic()" in source
