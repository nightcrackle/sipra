<div align="center">

<img src="assets/png/icon-256.png" width="128" alt="Sipra" />

# Sipra

**Split a song into stems on your own computer.**

No account. No upload. No subscription.

[![TypeScript](https://github.com/nightcrackle/sipra/actions/workflows/ci.yml/badge.svg)](https://github.com/nightcrackle/sipra/actions/workflows/ci.yml)
[![Python](https://github.com/nightcrackle/sipra/actions/workflows/python.yml/badge.svg)](https://github.com/nightcrackle/sipra/actions/workflows/python.yml)
[![Release](https://github.com/nightcrackle/sipra/actions/workflows/release.yml/badge.svg)](https://github.com/nightcrackle/sipra/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

</div>

---

Sipra takes an MP3, WAV or FLAC and separates it into vocals, drums, bass
and other — and optionally guitar and piano — then drops the result into a
waveform workspace where you can solo, mute, loop, balance and export.

Everything runs locally. Your audio is never uploaded, because there is
nowhere to upload it to: Sipra has no server and no account system.

!!!!! READ THIS !!!!!
There is an issue when adding a Music/Track for the first time. For this to work,
load the first track, and when it stalls, add the same track again and CANCEL the
first track. The second track and the following future tracks should go smoothly.
!!!!! READ THIS !!!!!

## What it actually does well, and what it doesn't

Read this before you decide whether Sipra is useful to you.

**Good.** The 4-stem model (`htdemucs`) is genuinely strong. Vocals, drums
and bass come out clean enough to practise against, remix, or pull a
reference from. This is the default and it is what most people should use.

**Uneven.** The 6-stem model (`htdemucs_6s`) adds guitar and piano. Guitar
is usable. **Piano bleeds badly** — Demucs' own documentation calls the
piano source "not working great" with "a lot of bleeding and artifacts",
and no amount of application code fixes that. Sipra labels both stems as
experimental in the interface rather than presenting six equally
trustworthy lanes. If you only need vocals, drums and bass, the 4-stem
model is cleaner *and* faster.

**Estimated, not measured.** BPM and key come from signal analysis and are
shown with a confidence rating. Relative major and minor keys share the
same notes, so a track that could be C major or A minor will be reported
with low confidence — that is the estimator being honest, not broken.

**Slow on CPU.** Expect roughly one to three minutes per song on a modern
processor. With an NVIDIA GPU it is five to twenty times faster. Sipra
detects which you have and installs the matching build.

## Getting started

Download the installer from
[Releases](../../releases), run it, and open Sipra.

The first launch installs the audio engine — around 900 MB, or 2.5 GB if
you have an NVIDIA GPU. This happens once. Afterwards Sipra works offline,
apart from downloading the weights for each separation model the first
time you use it.

Then drop a file anywhere in the window.

## The workspace

| | |
|---|---|
| **Play / pause** | `Space` |
| **Back to start** | `Home` |
| **Loop on/off** | `L` |
| **Hear the original** | Hold `O`, or hold the **Original** button |
| **Zoom** | `+` / `-`, or `Ctrl`+scroll |
| **Fit the whole track** | `0` |
| **Mark a loop** | Drag across any lane |
| **Seek** | Click a lane or the ruler |
| **Reset a fader** | Double-click it |

Each lane has a mute, a solo and a **selection** tick. Selection is the
one worth explaining: ticked stems are what you are working on, and
unticked stems drop to the **backing** level set in the transport bar. So
you can pull the vocal forward while the rest of the band keeps playing
behind it, without muting anything. Turn the backing fader fully down to
silence them instead.

## Exporting

- **A single stem** — the row of buttons under the lanes.
- **A custom mix** — the **Export** button. What you hear is what gets
  rendered: levels, mutes, solos and the backing balance all carry over.
  WAV (16/24-bit or 32-bit float), FLAC, or MP3 at 320 kbps. You can
  export just the looped region.

Normalising only ever turns a mix *down*, never up, so the balance you set
is preserved.

## The library

Saved tracks live in a searchable library with folders, drag-and-drop
filing, and a trash that keeps files on disk until you empty it (and
clears itself after 30 days). Search covers titles, file names, notes,
tags, key, Camelot code and BPM. Each track shows its length, BPM, key,
integrated loudness (EBU R128), true peak and crest factor.

## Importing from a link

Sipra can pull audio from a YouTube link if the build you are running
includes `yt-dlp`.

**Be clear about what that feature is.** Downloading from YouTube is
contrary to YouTube's Terms of Service. The confirmation checkbox in the
import dialog is not a licence and grants you no right you do not already
have — it records that the decision is yours. Use it for material you own,
material you have written permission to use, or material that is public
domain or openly licensed.

Builds can be made without the downloader entirely
(`SIPRA_BUNDLE_YTDLP=0`); the feature then reports itself unavailable and
nothing else changes. See [`NOTICE.md`](NOTICE.md).

## Privacy

Separation and analysis happen on your machine. Sipra reaches the network
exactly three times, all of them visible and optional:

1. Installing the audio engine, once, on first launch.
2. Downloading a separation model's weights, once per model.
3. Fetching a link, only if you paste one in.

There is no telemetry, no analytics, no crash reporting and no account.
[`PRIVACY.md`](PRIVACY.md) has the detail.

## When something looks stuck

Separating a full song on a CPU takes minutes, not seconds, and the
elapsed time next to a job is there so you can tell a long step from a
stopped one. If you want to know exactly what it is doing, the "Log"
button on a job that has been running a while — and "Show the log" on any
import error — opens `%APPDATA%\Sipra\logs\`. Every stage is timestamped
and every gap is measured, so the last line before a pause names the step
that did not finish. The log stays on your machine; see
[`PRIVACY.md`](PRIVACY.md).

If a job really has stopped, press Cancel. Sipra gives it eight seconds to
stop on its own and then restarts the audio engine, which is the only
thing that reclaims a native call that has stopped responding. Your
library is untouched and the next thing you do starts a fresh engine —
you should never need to close the application to get out of a stuck job.

To check the URL downloader on its own, without the app:

```bash
python -m sipra_core ytdlp-check
```

## Developing

```bash
npm install
npm run dev          # Vite + esbuild watch + Electron

npm run verify       # typecheck + lint + TypeScript tests
npm run test:py      # Python tests
npm run lint:py      # Python lint

npm run package      # Windows installer into release/
```

The Python core can be driven without the app at all:

```bash
python -m sipra_core capabilities
python -m sipra_core analyze song.wav
python -m sipra_core separate song.wav -o ./out --model htdemucs_6s
```

Set `SIPRA_ENABLE_FIXTURE_ENGINE=1` to get a fake engine that splits by
frequency band. It separates nothing, but it lets you exercise the whole
app — import, progress, workspace, export — without installing PyTorch.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how the pieces fit
together. [`docs/BUILDING.md`](docs/BUILDING.md) covers packaging.

## Continuous integration

Three workflows, three badges at the top of this file:

| Workflow | What it runs | When |
| --- | --- | --- |
| **TypeScript** (`ci.yml`) | typecheck, lint, 633 tests, production build — on Windows and Ubuntu | every push and pull request |
| **Python** (`python.yml`) | ruff, 487 tests — on Windows and Ubuntu, across Python 3.10, 3.11 and 3.12 | every push and pull request |
| **Release** (`release.yml`) | the full gate again, then the Windows installer | version tags, or on request |

The TypeScript workflow installs the Python core as well. That is not
redundant: the sidecar integration tests spawn a real Python process and
drive it over a real pipe, and without those dependencies present they
skip themselves silently — which would leave the boundary where most of
this project's real bugs have been entirely uncovered. PyTorch is
deliberately not installed anywhere in CI; a fixture engine that splits by
frequency band stands in for it, so a run takes minutes rather than
downloading two gigabytes.

Each run writes a one-line pass/fail summary to the GitHub run page, and
Windows and Ubuntu are reported separately so a platform-specific failure
is obvious from the badge page.

**Before pushing to GitHub**, point the badges at your repository:

```bash
npm run set-repo -- your-username/sipra   # or just `npm run set-repo` once origin is set
```

The badge URLs contain the owner and repository name, so until this is run
they render as blank images. The script rewrites all of them together —
editing three URLs by hand and getting one wrong produces a badge that
stays blank with nothing to indicate why.

## Built on

[Demucs](https://github.com/adefossez/demucs) for separation,
[librosa](https://librosa.org/) for tempo and key,
[pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) for loudness,
[Electron](https://www.electronjs.org/) and
[React](https://react.dev/) for the app.

Note that Demucs is archived upstream — Meta's repository is read-only and
the original author's fork accepts critical fixes only. Sipra is written
against a pluggable engine interface so a different model can be added
without touching the interface.

## Licence

MIT. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md) for the
third-party components.
