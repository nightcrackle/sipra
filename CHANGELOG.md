# Changelog

All notable changes to Sipra are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Sipra uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions below 1.0.0 are development milestones: the interface between the
Electron app and the Python core may change between them without a major
bump. 1.0.0 will be cut once the app has been run against real material on
real hardware.

---

## [0.9.0] — 2026-08-22

First feature-complete build. Everything described in the README works.

### Added

- **Documentation.** README stating plainly what the app does well and
  where it does not, `NOTICE.md` covering third-party licences and the
  position on bundling a downloader, `PRIVACY.md`, and architecture and
  build notes under `docs/`.
- **Packaging.** electron-builder configuration for a Windows NSIS
  installer, with the icon set generated from the supplied artwork.
- **CI.** GitHub Actions running type checks, lint, both test suites and a
  full build on Windows and Ubuntu, across Python 3.10, 3.11 and 3.12.
- `scripts/fetch-binaries.mjs` to pull FFmpeg and, behind the
  `SIPRA_BUNDLE_YTDLP` flag, `yt-dlp`.
- **End-to-end test of the Electron ↔ Python boundary.** Spawns the real
  sidecar over a real pipe and exercises capabilities, probing a file with
  a non-ASCII name, separation with progress, mix export, the URL rights
  gate, and responsiveness to a ping while a job runs. It also proves the
  peak files Python writes decode correctly in TypeScript — the one thing
  no unit test on either side can establish alone.

### Fixed

- Jobs created within the same millisecond — which is what happens when
  several files are dropped at once — listed oldest-first instead of
  newest-first. A sequence counter now breaks the tie.

---

## [0.8.0] — 2026-08-22

### Added

- **Settings.** Model and stem-preset selection, processing device,
  export defaults, meter ballistics, and an About panel reporting the
  resolved runtime and PyTorch build.
- **Export dialog.** Renders exactly what is audible in the workspace,
  including the backing-bus balance, to WAV / FLAC / MP3, optionally
  limited to the looped region.
- **Import dialog.** File picker and URL import, the latter behind an
  explicit rights confirmation that states what it is and is not.

### Changed

- The 6-stem model now surfaces a standing warning in the workspace rather
  than presenting guitar and piano as equal to the other four lanes.

---

## [0.7.0] — 2026-08-22

### Added

- **Library interface.** Folder sidebar with drag-and-drop filing, track
  grid with BPM / key / loudness metadata, multi-select, sorting, and a
  trash view with restore and permanent delete.
- Full-text search across titles, file names, notes, tags, key, Camelot
  code and BPM, with every token required so extra words narrow results.

### Fixed

- Deleting a folder no longer risks orphaning its tracks; they move to the
  unfiled root and stay findable.

---

## [0.6.0] — 2026-08-22

### Added

- **Waveform workspace.** Per-stem lanes with canvas waveforms, shared
  viewport, time ruler, playhead, and drag-to-loop.
- **Transport.** Play/pause, stop, seek, loop enable, zoom in/out/fit/loop,
  follow-playhead, master fader and master meter.
- **Level meters** with proper ballistics — instant attack, bounded
  release, held peak marker and a clip indicator that stays lit long
  enough to be seen.
- Keyboard shortcuts for the whole transport.

### Changed

- Waveform lanes switch from the precomputed envelope to decoded samples
  once zoomed past one bucket per pixel, so deep zoom shows the real
  waveform instead of an interpolated invention.

### Fixed

- The lane fader taper ran backwards, giving coarse control around unity —
  where mixing actually happens — and needlessly fine control at the
  bottom of the scale. Replaced with a cube-root curve placing unity at
  78% of travel.
- The level-meter scale compressed the loud end for the same reason.
  Replaced with a curve giving the top 12 dB roughly 40% of the meter.
- Peak and RMS meter modes shared a release rate through a ternary whose
  branches were identical. They now have distinct, appropriate rates.

---

## [0.5.0] — 2026-08-22

### Added

- **Playback engine.** Every stem is its own source node, started at one
  scheduled context time with one offset, which is what keeps six lanes
  sample-locked.
- Native `loop`/`loopStart`/`loopEnd` on the source nodes, so loop wrap
  happens on the audio thread with no gap.
- Per-lane gain, mute, solo and selection, with an auto-computed backing
  bus for unselected stems and a momentary original-mix A/B.

### Changed

- Gain changes ramp linearly rather than exponentially: `setTargetAtTime`
  never quite reaches zero, so a "muted" stem stayed faintly audible.

---

## [0.4.0] — 2026-08-22

### Added

- **Electron main process.** Secure window configuration — context
  isolation on, sandbox on, no Node integration — with a named-channel
  preload bridge and no generic invoke escape hatch.
- **First-run runtime manager.** Builds a private Python environment using
  a bundled `uv`, `uv` from PATH, or a system Python 3.10+, detects an
  NVIDIA GPU and installs the matching PyTorch build.
- **`sipra://` media scheme** for streaming audio and peak files into the
  renderer without copying them through IPC.
- Job registry with progress, cancellation and bounded history.
- Atomic JSON persistence for the library and settings, with quarantine
  and recovery when a file is found corrupt.

### Security

- The media resolver takes a track id and an asset kind, never a path, and
  re-checks that the resolved file sits inside the workspace. A crafted URL
  cannot reach a file the library does not already know about.
- Track patches from the renderer are whitelisted, so a bug there cannot
  rewrite `trackDir` or `sourcePath`.
- Library file deletion refuses any directory outside the workspace.

---

## [0.3.0] — 2026-08-22

### Added

- **Separation pipeline** tying decode, separation, stem writing, peak
  generation and analysis into one monotonic progress fraction.
- **Mixdown** with block-streamed summing, solo/mute resolution, time-range
  export and WAV / FLAC / MP3 output.
- **NDJSON stdio server** with a background worker, so a long separation
  never blocks a cancel or a ping.
- Local file ingest with Windows-safe filename handling, and URL ingest
  behind a rights gate and a host allowlist.

### Fixed

- Integer WAV output clipped rather than wrapped. libsndfile wraps on
  overflow, which turns a hot stem into loud digital noise.
- A silent stem reported `-inf` dB, which is not representable in JSON and
  broke the IPC decode. It now reports `null`.

---

## [0.2.0] — 2026-08-22

### Added

- **Analysis.** Tempo estimation with octave folding, key detection by
  Krumhansl-Schmuckler template matching against both Krumhansl-Kessler
  and Temperley profiles, ITU-R BS.1770 integrated loudness, EBU R128
  loudness range, sample peak, 4x-oversampled true peak and crest factor.
- Confidence figures for tempo and key, so an uncertain estimate can be
  shown as uncertain rather than stated as fact.
- Waveform peak generation with a compact binary format.

### Fixed

- Tempo derived from the median inter-beat interval inherited the analysis
  hop quantisation and could be two BPM out. A least-squares fit over the
  longest run of evenly-spaced beats now recovers the tempo to within
  0.1 BPM on a click track.

---

## [0.1.0] — 2026-08-22

Project started.

### Added

- **Pluggable separation engine interface**, with a Demucs implementation
  covering `htdemucs`, `htdemucs_ft`, `htdemucs_6s` and `mdx_extra`, and a
  fixture engine for development without PyTorch.
- Audio decoding via libsndfile with an FFmpeg fallback for formats it
  cannot open.
- Canonical six-stem vocabulary shared between the Python core and the
  TypeScript app, with guitar and piano flagged experimental from the
  outset.
- Cooperative cancellation, structured error codes, and the repository
  scaffold: TypeScript, Vite, Electron, Vitest, pytest and Ruff.

### Notes

- The 6-stem model was flagged experimental in the very first commit
  rather than later. Demucs' own documentation describes its piano source
  as bleeding heavily, and the interface says so rather than implying six
  equally good stems.
- Demucs is archived upstream. The engine interface exists so a
  replacement can be dropped in without touching the interface.

[0.9.0]: https://github.com/OWNER/sipra/releases/tag/v0.9.0
[0.8.0]: https://github.com/OWNER/sipra/releases/tag/v0.8.0
[0.7.0]: https://github.com/OWNER/sipra/releases/tag/v0.7.0
[0.6.0]: https://github.com/OWNER/sipra/releases/tag/v0.6.0
[0.5.0]: https://github.com/OWNER/sipra/releases/tag/v0.5.0
[0.4.0]: https://github.com/OWNER/sipra/releases/tag/v0.4.0
[0.3.0]: https://github.com/OWNER/sipra/releases/tag/v0.3.0
[0.2.0]: https://github.com/OWNER/sipra/releases/tag/v0.2.0
[0.1.0]: https://github.com/OWNER/sipra/releases/tag/v0.1.0
