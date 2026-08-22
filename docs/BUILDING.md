# Building Sipra

## Requirements

- **Node.js 20+**
- **Python 3.10+** — only needed to run the Python tests and the
  cross-language parity test. The app installs its own Python at runtime.
- **Windows** for producing the installer. The code is cross-platform, but
  `electron-builder` cannot make a Windows installer from Linux without
  Wine, and the result is not worth trusting.

## Development

```bash
npm install
npm run dev
```

That starts the Vite dev server, esbuild in watch mode for the main and
preload bundles, and Electron once Vite is actually listening.

### Working without PyTorch

Installing 900 MB of PyTorch to change a button is wasteful. There is a
fixture engine that splits audio by frequency band — it separates nothing,
but the whole app works end to end:

```bash
# In the environment the sidecar runs in
SIPRA_ENABLE_FIXTURE_ENGINE=1
```

Then pick "Fixture band split" in Settings. The interface labels it
explicitly so nobody mistakes the output for real stems.

### Driving the core directly

```bash
cd python
python -m sipra_core capabilities
python -m sipra_core analyze ../song.wav
python -m sipra_core separate ../song.wav -o ./out --model htdemucs_6s
python -m sipra_core serve          # what Electron talks to
```

Useful for reproducing a bug report without launching the app.

## Verification

```bash
npm run verify      # typecheck + lint + TypeScript tests
npm run test:py     # pytest
npm run lint:py     # ruff
```

CI runs all of these on Windows and Ubuntu, across Python 3.10, 3.11 and
3.12, plus a full build.

## Packaging a Windows installer

```bash
node scripts/fetch-binaries.mjs
npm run package
```

The installer lands in `release/`.

`fetch-binaries.mjs` pulls FFmpeg and `yt-dlp` into `bin/`. Neither is
committed — they are large and carry their own licences.

### Building without the downloader

```bash
SIPRA_BUNDLE_YTDLP=0 node scripts/fetch-binaries.mjs
npm run package
```

The URL-import tab reports itself unavailable; nothing else changes. Read
[`../NOTICE.md`](../NOTICE.md) before deciding. In CI, set the
`SIPRA_BUNDLE_YTDLP` repository variable to `0`.

### Code signing

Unsigned installers trigger a SmartScreen warning on first run, and there
is no way around that other than a certificate. With one:

```bash
set CSC_LINK=path\to\certificate.pfx
set CSC_KEY_PASSWORD=...
npm run package
```

Never commit a certificate. In CI use encrypted secrets.

## What ships in the installer

| Path | Contents |
|---|---|
| `resources/app.asar` | Renderer bundle and main process |
| `resources/python/` | The audio core, as source — the sidecar imports it |
| `resources/bin/` | FFmpeg, and `yt-dlp` if the build includes it |
| `resources/build/` | Application icons |

The Python **runtime** is not in the installer. It is built into
`%APPDATA%\Sipra\runtime\` on first launch, which is what keeps the
installer around 120 MB instead of 2.5 GB.

## Regenerating icons

`assets/icon.svg` is the master. To regenerate the PNG set and the `.ico`:

```bash
npm run icons
```

Needs `rsvg-convert` (librsvg) and ImageMagick. The `.ico` must contain a
256×256 entry or `electron-builder` rejects it.

## Release checklist

1. `npm run verify && npm run test:py && npm run lint:py`
2. Bump the version in `package.json` **and** `python/pyproject.toml` and
   `python/sipra_core/__init__.py` — they are compared at runtime.
3. Add a `CHANGELOG.md` entry.
4. Tag `vX.Y.Z` and push. CI builds and uploads the installer.
5. Check the installer on a machine that has never run Sipra: first-run
   setup is the part most likely to break, and it only breaks on a clean
   machine.
