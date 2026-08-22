"""Entry point for the sidecar and for a small offline CLI.

    python -m sipra_core serve                 # NDJSON stdio server (Electron uses this)
    python -m sipra_core capabilities          # what this machine can do, as JSON
    python -m sipra_core analyze <file>        # BPM / key / loudness
    python -m sipra_core separate <file> -o d  # separate without the UI

The CLI exists so the core can be exercised, scripted and debugged without
launching Electron — which also makes it straightforward to reproduce a
bug report from a terminal.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from . import __version__


def _configure_streams() -> None:
    """Force UTF-8 on stdio.

    Windows consoles still default to a legacy code page, and a track
    titled with a non-ASCII character would otherwise crash the sidecar on
    the first response that mentions its name.
    """
    for stream_name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, io.UnsupportedOperation):  # pragma: no cover
                pass


def _cmd_serve(args: argparse.Namespace) -> int:
    from .server import SipraServer

    server = SipraServer()
    return server.serve_forever()


def _cmd_capabilities(args: argparse.Namespace) -> int:
    from .engines.registry import EngineRegistry
    from .protocol import Request
    from .server import SipraServer

    server = SipraServer(EngineRegistry(), stdout=io.StringIO())
    from .server import _h_capabilities

    payload = _h_capabilities(server, Request(id="cli", method="capabilities"))
    print(json.dumps(payload, indent=2, default=str))
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    from .analysis import analyse_file

    def report(stage: str, fraction: float) -> None:
        if not args.quiet:
            print(f"  {stage:<10} {fraction * 100:5.1f}%", file=sys.stderr)

    analysis = analyse_file(args.path, include_beats=args.beats, on_progress=report)
    print(json.dumps(analysis.to_dict(include_beats=args.beats), indent=2))
    return 0


def _cmd_separate(args: argparse.Namespace) -> int:
    from .separation import separate_track

    last = -1.0

    def report(stage: str, fraction: float) -> None:
        nonlocal last
        if args.quiet:
            return
        if fraction - last >= 0.01 or fraction >= 1.0:
            last = fraction
            print(f"  {stage:<10} {fraction * 100:5.1f}%", file=sys.stderr)

    outcome = separate_track(
        input_path=args.path,
        output_dir=args.output or Path(args.path).with_suffix(""),
        engine_id=args.engine,
        model_id=args.model,
        stems=args.stems.split(",") if args.stems else None,
        device=args.device,
        analyse=not args.no_analyse,
        on_progress=report,
    )
    print(json.dumps(outcome.to_dict(), indent=2, default=str))
    return 0


def _cmd_ytdlp_check(args: argparse.Namespace) -> int:
    """Report on the downloader without needing the app to be running.

    The app-side check lives in the import dialog, but if a job is already
    wedged that is an awkward place to reach it from. This is the same
    report from a terminal, and it is what a bug report should carry.
    """
    from .ingest import youtube

    report = youtube.diagnose()
    print(json.dumps(report, indent=2, default=str))

    if report.get("canReachYoutube"):
        return 0
    if report.get("error"):
        print("", file=sys.stderr)
        print(f"Problem: {report['error']}", file=sys.stderr)
        for hint in report.get("hints") or []:
            print(f"  - {hint}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sipra_core", description="Sipra audio core: separation and analysis"
    )
    parser.add_argument("--version", action="version", version=f"sipra-core {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("serve", help="Run the NDJSON stdio server").set_defaults(func=_cmd_serve)
    sub.add_parser("capabilities", help="Print engine/model availability").set_defaults(
        func=_cmd_capabilities
    )

    analyze = sub.add_parser("analyze", help="Measure BPM, key and loudness")
    analyze.add_argument("path")
    analyze.add_argument("--beats", action="store_true", help="Include the beat grid")
    analyze.add_argument("-q", "--quiet", action="store_true")
    analyze.set_defaults(func=_cmd_analyze)

    separate = sub.add_parser("separate", help="Separate a file into stems")
    separate.add_argument("path")
    separate.add_argument("-o", "--output", help="Output directory")
    separate.add_argument("--engine", default=None)
    separate.add_argument("--model", default=None, help="e.g. htdemucs, htdemucs_6s")
    separate.add_argument("--stems", default=None, help="Comma-separated subset")
    separate.add_argument("--device", default=None, help="cuda or cpu")
    separate.add_argument("--no-analyse", action="store_true")
    separate.add_argument("-q", "--quiet", action="store_true")
    separate.set_defaults(func=_cmd_separate)

    sub.add_parser(
        "ytdlp-check",
        help="Report whether the URL downloader is present, starts and can reach YouTube",
    ).set_defaults(func=_cmd_ytdlp_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    _configure_streams()
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:  # pragma: no cover
        return 130
    except Exception as exc:
        from .errors import SipraError

        if isinstance(exc, SipraError):
            print(json.dumps({"error": exc.to_dict()}, indent=2), file=sys.stderr)
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
