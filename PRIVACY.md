# Privacy

Short version: your audio stays on your computer, and Sipra has no way to
receive it even if it wanted to.

## What Sipra does not do

- **No account.** There is no sign-up, no login, no identity.
- **No upload.** Separation and analysis run in a process on your machine.
  Audio is never transmitted anywhere.
- **No telemetry.** No analytics, no usage counters, no crash reporting.
- **No server.** Sipra has no backend. There is nothing to send data to.

## What Sipra stores, and where

Everything lives in Sipra's own application-data folder:

```
%APPDATA%\Sipra\
  workspace\
    library.json          the track index
    settings.json         your preferences
    tracks\<track>\
      source.wav          a copy of the audio you imported
      stems\*.wav         the separated stems
      peaks\*.speaks      waveform data for drawing lanes
    downloads\            staging for URL imports, cleared after import
  runtime\                the private Python environment
```

Deleting that folder removes everything Sipra knows.

Sipra takes a **copy** of the audio you import rather than referencing the
original. That is deliberate: the library keeps working after you move,
rename or delete the file you dropped in. Your originals are never
modified.

## When Sipra uses the network

Three times, all of them visible and all of them optional in the sense
that nothing happens without you starting it:

1. **Installing the audio engine.** Once, on first launch. Downloads
   Python packages from PyPI and PyTorch's package index.
2. **Downloading model weights.** Once per separation model, the first
   time you use it, from the Demucs release assets.
3. **Fetching a link.** Only if you paste a URL into the import dialog.

That is the complete list. After the first two, Sipra works with no
network connection at all.

## Browser storage and the renderer

The interface is a locally-loaded page with a strict Content-Security
-Policy: no remote origins, no inline scripts, no `eval`. It runs with
Node integration disabled, context isolation enabled and the sandbox on,
and can only reach the main process through a fixed list of named
channels.

## Files you export

Exported stems and mixes go wherever you choose in the save dialog.
Nothing is written outside Sipra's own folder except the files you
explicitly export.

## The trash

Deleting a track moves it to the trash and leaves its files on disk.
Emptying the trash deletes them. Anything left in the trash for 30 days is
removed automatically. Sipra will only ever delete a directory that sits
inside its own workspace.

## If you use URL import

The request goes from your machine to the site you linked, through
`yt-dlp`. Sipra adds nothing to it and sees nothing that `yt-dlp` does not
report back. Read [`NOTICE.md`](NOTICE.md) for the position on that
feature.
