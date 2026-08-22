# Third-party components and legal notes

Sipra itself is MIT licensed. It depends on, and optionally bundles, work
by other people under other licences.

---

## Read this before publishing a build with `yt-dlp` in it

Sipra can import audio from a YouTube link when a `yt-dlp` binary is
present. Whether to ship that binary is a decision for whoever publishes
the build, and it should be a considered one.

**The facts, plainly:**

- Downloading from YouTube is contrary to YouTube's Terms of Service.
  This is true regardless of who owns the copyright in the underlying
  recording.
- The confirmation checkbox in Sipra's import dialog is **not a licence**.
  It does not transfer any right to the person ticking it, and it does not
  make the download lawful. It records that the decision is theirs.
- `yt-dlp` and its predecessor `youtube-dl` have both been the subject of
  takedown notices. Distributing a downloader attracts attention that
  distributing an audio editor does not.

**How to build without it:**

```bash
SIPRA_BUNDLE_YTDLP=0 node scripts/fetch-binaries.mjs
npm run package
```

The URL-import tab then reports itself unavailable and everything else
works unchanged. Nothing else in the application depends on it. In CI, set
the `SIPRA_BUNDLE_YTDLP` repository variable to `0`.

The feature is also confined by design: Sipra accepts URLs only on an
allowlist of YouTube hosts, refuses recordings longer than 20 minutes, and
will not start a download without the explicit confirmation.

---

## Bundled binaries

Fetched by `scripts/fetch-binaries.mjs` into `bin/`. Not committed to this
repository.

| Component | Licence | Purpose |
|---|---|---|
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1-or-later (the essentials build; GPL components excluded) | Decoding formats libsndfile cannot open; MP3 export |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | URL import — **optional, see above** |

FFmpeg is used as a separate executable invoked over a process boundary,
not linked into Sipra.

---

## Python dependencies

Installed into a private environment on first launch. Nothing here is
committed or redistributed by Sipra; each is downloaded from PyPI by the
user's own machine.

| Component | Licence | Purpose |
|---|---|---|
| [Demucs](https://github.com/adefossez/demucs) | MIT | Source separation |
| [PyTorch](https://pytorch.org/) | BSD-3-Clause | Neural network runtime |
| [torchaudio](https://pytorch.org/audio/) | BSD-2-Clause | Audio tensor operations |
| [librosa](https://librosa.org/) | ISC | Tempo and chroma analysis |
| [NumPy](https://numpy.org/) | BSD-3-Clause | Numerics |
| [SciPy](https://scipy.org/) | BSD-3-Clause | Filtering and resampling |
| [SoundFile](https://python-soundfile.readthedocs.io/) | BSD-3-Clause | libsndfile bindings |
| [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) | MIT | ITU-R BS.1770 loudness |
| [Numba](https://numba.pydata.org/) | BSD-2-Clause | librosa acceleration |

### Model weights

Demucs model weights are downloaded on first use from the Demucs release
assets and are **not** redistributed by Sipra. They are released by their
authors under the terms stated in the Demucs repository. If you plan to
use separated output commercially, check those terms yourself.

---

## JavaScript dependencies

See `package.json` and `package-lock.json`. The direct dependencies are:

| Component | Licence |
|---|---|
| [Electron](https://www.electronjs.org/) | MIT |
| [React](https://react.dev/) | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Vite](https://vitejs.dev/) | MIT |
| [esbuild](https://esbuild.github.io/) | MIT |
| [Vitest](https://vitest.dev/) | MIT |
| [electron-builder](https://www.electron.build/) | MIT |

---

## On the audio you process

Sipra does not check what you feed it and cannot. Separating a recording
creates a derivative work of it. Owning a copy of a song is not the same
as holding the right to distribute stems of it, and "I bought the album"
is not a licence to publish an acapella.

Sipra is built for people working with their own material, material they
have permission to use, and material that is openly licensed. What you do
beyond that is your responsibility, not the application's.
