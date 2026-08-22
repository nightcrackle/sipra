# Architecture

Sipra is three processes with two boundaries between them.

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer  (Chromium, sandboxed)                            │
│  React + Zustand · Web Audio · canvas waveforms             │
│                                                             │
│  No Node. No filesystem. No network.                        │
└───────────────┬───────────────────────────┬─────────────────┘
                │ IPC (named channels)      │ sipra:// (media)
┌───────────────▼───────────────────────────▼─────────────────┐
│  Main  (Node)                                               │
│  window · library · settings · jobs · runtime setup         │
└───────────────┬─────────────────────────────────────────────┘
                │ NDJSON over stdin/stdout
┌───────────────▼─────────────────────────────────────────────┐
│  Sidecar  (Python)                                          │
│  decode · separate · analyse · peaks · mixdown              │
└─────────────────────────────────────────────────────────────┘
```

## Why a Python sidecar

Demucs is PyTorch, and PyTorch is Python. The alternatives were exporting
the model to ONNX (which `htdemucs_6s` does not support well) or
reimplementing inference, neither of which is worth it. A sidecar keeps
the model in the ecosystem it was written for.

It is a separate *process*, not a library binding, for a practical reason:
if PyTorch segfaults on a bad input — which it occasionally does — the app
survives, reports the failure, and restarts the engine on the next action.

## Why Electron rather than a native toolkit

The workspace is six synchronised waveform lanes with zoom, loop regions,
level meters and sample-accurate multi-stream playback. Web Audio gives
that almost for free; the same thing in a native toolkit means writing an
audio graph and a canvas renderer from scratch. The cost is Electron's
footprint, which is small next to the 900 MB of PyTorch that has to ship
regardless.

## The two boundaries

### Renderer ↔ Main

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`
and `sandbox: true`. Everything it can do is one of the named channels in
`shared/ipc.ts`, exposed through `electron/preload.ts` as individually
wrapped methods.

There is deliberately **no generic `invoke(channel, ...args)`**. A generic
bridge would let anything injected into the renderer call anything the
main process handles, which defeats the point of the sandbox.

Every handler validates its arguments. Track patches go through a
whitelist (`electron/ipc/sanitise.ts`) so a renderer bug that spread a
whole track object into a patch cannot rewrite `trackDir` and point the
media resolver somewhere new.

### Audio into the renderer: the `sipra://` scheme

Stems are tens of megabytes. Copying them through IPC to decode them would
be wasteful, so they are streamed over a custom protocol instead.

The renderer never sends a path. It asks for `sipra://media/<trackId>/<kind>`
and the main process resolves that against the library index. Two
consequences:

- A crafted URL cannot reach a file the library does not already know about.
- The resolved path is re-checked to be inside the workspace before
  anything is read, so a hand-edited `library.json` cannot turn the scheme
  into an arbitrary file reader.

### Main ↔ Sidecar

One JSON object per line, both directions. Requests carry an id;
responses echo it; progress arrives as unsolicited events in between.

The framing is boring on purpose. The one rule that matters: **stdout
carries protocol lines only.** Anything a dependency prints is redirected
to stderr, because a stray `print` on stdout would desynchronise the
stream. Lines that fail to parse are logged and skipped rather than
treated as messages.

## The parts worth knowing about

### Sample-locked playback (`src/audio/StemPlayer.ts`)

Six lanes stay in sync because every source node is started at the *same
scheduled context time* with the same offset. Starting them "now" in a
loop drifts by a buffer between the first call and the sixth.

Looping uses the source nodes' own `loop`/`loopStart`/`loopEnd`, so the
wrap happens on the audio thread. Restarting sources from a JavaScript
timer puts an audible gap at every loop point.

### Waveform rendering (`shared/peaks.ts`, `src/components/WaveformCanvas.tsx`)

Python writes a min/max envelope alongside each stem, so a waveform
appears the instant a track opens rather than after several hundred
megabytes have decoded. The renderer draws from that envelope until zoom
passes one bucket per pixel, then switches to decoded samples.

It repeats buckets rather than interpolating between them. An interpolated
waveform draws amplitudes the audio never contained.

### Mix resolution (`shared/mix.ts`)

What you hear is decided by one pure function, so the rules are testable
rather than discovered by ear:

1. If anything is soloed, only soloed lanes sound.
2. A muted lane is silent even if also soloed.
3. An unselected lane is silent, unless a backing-bus level is set, in
   which case it sounds at that level.
4. Lane fader, then master fader.

The export dialog calls the same function, which is why the rendered file
matches what was being auditioned.

### First-run setup (`electron/services/runtime.ts`)

Builds a private Python environment in the app-data folder, preferring
`uv` (which installs its own pinned CPython, so the result does not depend
on whatever Python the user has) and falling back to a system Python 3.10+.

Probes for an NVIDIA GPU with `nvidia-smi` and installs the matching
PyTorch build. The probe errs towards CPU: a false negative costs speed, a
false positive costs a 2.5 GB download that then fails at runtime.

Everything that touches a real process goes through a `ProcessRunner`
interface, so the whole state machine — including the failure paths people
actually hit — is tested without downloading anything.

### Library (`shared/library.ts`, `electron/services/library.ts`)

A JSON file, not a database. Personal libraries are hundreds to low
thousands of tracks; an in-memory index searches that instantly, and
avoiding a native module removes a whole class of build pain from
`electron-rebuild`.

Writes are atomic — temp file, fsync, rename — so a crash mid-write leaves
the previous version intact. A file that fails to parse is quarantined
rather than deleted, and the app starts fresh instead of refusing to boot.

All the "what does the library look like after this action" logic is pure
functions in `shared/`. The service adds only the filesystem.

## Testing

**Python (`python/tests/`).** Assertions are anchored to values derivable
on paper, not to whatever the implementation produced first: a -20 dBFS
sine really is -20 dBFS, a 120 BPM click track really is 120 BPM, an
Am-Dm-E-Am progression really is in A minor.

The full pipeline is exercised end to end using a fixture engine that
splits by frequency band. Its bands sum back to the input exactly, which
lets the reconstruction assertions be strict rather than approximate. It
is registered only under `SIPRA_ENABLE_FIXTURE_ENGINE=1` so nobody is ever
handed frequency bands and told they are stems.

**TypeScript (`tests/`).** Every pure module — mix maths, viewport, meter
ballistics, loop regions, WAV encoding, peak decoding, library queries,
path safety, NDJSON framing — plus the main-process services, driven
through injected fakes.

One test runs the real Python and compares its stem vocabulary against the
TypeScript one, so the two cannot drift apart unnoticed.
