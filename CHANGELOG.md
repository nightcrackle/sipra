# Changelog

All notable changes to Sipra are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Sipra uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions below 1.0.0 are development milestones: the interface between the
Electron app and the Python core may change between them without a major
bump. 1.0.0 will be cut once the app has been run against real material on
real hardware.

---

## [0.9.15] — 2026-08-25

The decode fix in 0.9.14 worked: the import now gets past 32% and through
separation. It stalls at 96% instead — the same fault, one stage later,
and now the last one that could still do this.

The log narrows it to a single call. `analyse 96%` is the loudness
measurement having reported that it was starting; the next report, at 97%,
never arrives. Analysis is numpy, scipy and librosa, running inside the
sidecar, and a native call that stalls there cannot be timed out,
cancelled or killed. The cancellation checks added in 0.9.14 sit *between*
measurements, so they were never reached.

### Changed

- **Analysis runs in a child process.** Bounded, watched for having gone
  quiet, and killable — the same treatment decoding got in 0.9.14, for the
  same reason and against the same evidence. It is the last thing a job
  does, so the process start costs nothing anybody notices. It reuses the
  `analyze` command that already existed for debugging from a terminal.

  With this, every stage that touches native code — decode, separation,
  analysis — either runs in a child process or reports progress often
  enough that a stall is caught. There is no longer a step that can stop
  the engine dead.

- **The analysis child is given the parent's import path** rather than
  relying on the working directory. Found by the tests: under a runner the
  import path comes from the runner, not the directory, and a child that
  assumed otherwise failed instantly. Any caller working from a different
  directory would have hit the same thing.

### Added

- `--key-profile` on the `analyze` command, which the API had and the
  command line did not.

### Tests

- 644 TypeScript tests, 586 Python tests.
- The child's measurements are pinned against the in-process ones —
  loudness, key, duration — so moving the work cannot move the numbers.
- Progress relayed out of the child, a deadline that fires, cancellation
  that stops it, and a run from an unrelated working directory.

### On the shape of these three releases

0.9.13 fixed a killed process being able to mark its replacement dead.
0.9.14 moved decoding out of process. This moves analysis. All three are
the same lesson arriving in instalments: work that cannot be interrupted
does not belong on the thread that everything else waits behind. That was
worth stating once, at the start, rather than three times in a row.

---

## [0.9.14] — 2026-08-25

`unchangedForMs: 464769` — eight minutes on one line, and the line that
finally located this. 32% on the bar is the decoder between seventy and a
hundred per cent of the way through the file, and only one of the two
decode paths can sit there silently for eight minutes: the one that runs
inside this process.

Had it been ffmpeg, the stall detector added in 0.9.10 would have ended it
after two minutes with a message. It was libsndfile, which reads in
process — and a native read cannot be timed out, cancelled or killed. It
holds the only worker there is until the application is closed.

That also explains the workaround that has worked every time: the second
attempt runs after a restart, on a fresh process, against a file that is
no longer freshly written.

### Changed

- **Decoding happens in a child process where ffmpeg is available.** Not
  because ffmpeg reads audio better — libsndfile reads WAV, FLAC and Ogg
  perfectly well — but because a child process can be given a deadline,
  watched for having gone quiet, and killed, and an in-process native read
  can be none of those things. Every decode is now bounded, cancellable,
  and reports real progress. libsndfile remains the fallback where ffmpeg
  is missing; `SIPRA_DECODER=libsndfile` forces it back.

  This does not explain *why* that read stalls. It does mean that if it
  stalls again you get an error naming how far it got, after two minutes,
  instead of an application that has to be restarted.
- **Analysis can be cancelled.** It was the one stage that ignored the
  request entirely — and it is the slowest on a cold machine and the last
  in the job, which makes it exactly where somebody gives up. A cancel
  during it now ends the job rather than being recorded as a failed
  measurement and stepped past.

### Tests

- 644 TypeScript tests, 581 Python tests.
- Both decoders are pinned against each other: same file, same samples, so
  changing which one runs cannot change what anybody hears.
- A stalled decode must not fall back to the reader that cannot be
  stopped — otherwise a decode that correctly refused to wait forever
  would go on to wait forever.
- Cancellation is covered for both readers separately.
- The pipeline test no longer carries the analysis cost; analysis has its
  own test, last, on the largest budget in the file. Parts of librosa
  compile on first use, which on a cold Windows runner is minutes, and
  carrying it inside the one test that covers the whole pipeline is what
  made that test overrun and take five others down with it.

---

## [0.9.13] — 2026-08-25

You were right that the test failures and the application failure are
connected. They share a mechanism, and it is a serious one.

### Fixed

- **A killed process could mark its replacement dead.** Killing a process
  does not make it go quiet. Its exit event, and any output still in
  flight, arrive whenever the operating system gets to them — on a slow
  machine, *after* a replacement has already been spawned. Every handler
  attached to the old process wrote to state shared with whatever was
  current, so the corpse announced the live engine as gone and rejected
  work it was perfectly able to do. Leftover bytes from the old process
  could likewise be fed into the new one's message stream.

  This is why every job after a restart reported "the audio engine did not
  answer in time" while the engine was listening the whole while. It is
  also the second notification you saw: cancelling a stuck job restarts
  the engine, and the restart left the client convinced there was nothing
  there. Handlers now check they still speak for the running process.

  Reproduced deterministically by spawning the replacement before the old
  process has finished dying, and verified by removing the guard and
  watching those tests fail.

### Removed

- **The analysis warm-up added in 0.9.12.** It warmed with a second of
  silence, and analysis short-circuits on silence — measured here, a real
  signal still paid the full cost afterwards, so it bought about four
  seconds while adding an unbounded step to setup and to the test suite's
  fixture. On the Windows runner that fixture then exceeded ten minutes
  and took fourteen tests down with it. It did not do what it claimed and
  it is gone.

### Tests

- 643 TypeScript tests, 573 Python tests.
- Three new tests for a restart whose old process reports late: an async
  request afterwards, three restarts in a row, and a real separation.
  Without the guard, two fail immediately with the engine reported
  unavailable.

### What this does not fix

The import stopping at 32% on "Reading the file" is still unexplained.
32% is the decoder about ninety-five per cent of the way through the file,
which is a strange place to stop and not one this release accounts for.

What has changed is the consequence: cancelling such a job now genuinely
recovers the engine, instead of leaving an application that appears to
work and answers nothing. If it stalls again, the log is what will settle
it — and it should now name the decoder and how far it got, or have turned
the stall into an error saying so.

---

## [0.9.12] — 2026-08-25

Ten test failures on Windows CI. One was a real fault, one was a real bug
in shipped code, and the remaining eight were consequences of the first.

### Fixed

- **Abandoning a request left the engine occupied.** Heavy methods run one
  at a time on purpose, and a request whose caller gave up waiting kept
  running — so every later job queued behind one nobody wanted any more.
  In CI that turned a single overrunning test into six more failures; in
  the app it means a job that overran its budget quietly blocks everything
  after it. A timed-out request now cancels its own job. Verified by
  disabling the fix and watching the test fail: 63 seconds without it, 2
  with.
- **A path check compared two paths in different forms.** The asset was
  resolved, the workspace it was checked against was not. On Windows
  `resolve` turns a root-relative path into a drive-qualified one, so a
  file genuinely inside the workspace stopped looking like it was. Both
  sides are resolved now. In production both arrive absolute and native so
  this never showed — it took a Windows run to expose the asymmetry.

### Changed

- **Setup warms the analysis stage as well as the model.** Tempo and key
  detection compile part of librosa on first use — tens of seconds on a
  cold machine, and it landed at the very end of the user's first
  separation, which is the least forgivable place for an unexplained
  pause. Setup absorbs it, the same as the model download.
- **Integration test budgets are set for the slowest supported platform.**
  A Windows runner is roughly ten times slower here than a developer
  machine. Budgets tuned locally produced failures that taught nothing
  except to distrust the suite. Three of the ten failures were tests that
  do nothing but check an argument is rejected — they never got a turn
  inside the default five seconds while the engine was busy.

### Tests

- 640 TypeScript tests, 573 Python tests.
- The abandoned-request case is now covered end to end, through a real
  process over a real pipe: a caller gives up, and the next job has to run
  promptly rather than queueing — and the engine must be freed by
  cancelling, not by being killed and restarted.
- The test-only wedge method gained a cancellable mode, so both halves are
  reproducible: work that ignores cancellation, which only a restart can
  reclaim, and ordinary long work, which a cancel should end.
- The media fixture builds paths rather than hard-coding POSIX literals,
  so it means the same thing on both platforms.

### Note

The reported import problem is still not explained. Nothing here claims to
fix it. What this does fix is a mechanism that would make any single stuck
job look like a wholly broken application, which is worth removing on its
own merits.

---

## [0.9.11] — 2026-08-25

The Windows CI failures and the import failures were the same problem
seen from two sides, and the connection is what fixes it properly.

Three tests failed on `windows-latest` with `Invalid argument` while
creating files named `Song ** stars`, `Song ? maybe` and `a[b]c*d?e`.
Windows forbids `*` and `?` in filenames outright, so those tests could
only ever have passed on Linux. But the reason such names were being
tested at all is that the video's title was going into the download's
path — and that is the actual fault.

A title is arbitrary text, and that path is handed to three systems that
each read part of it as syntax:

* `glob`, which reads `[`, `]`, `*` and `?` as pattern syntax — this
  already broke finding the file in 0.9.9;
* yt-dlp's output template, where `%` begins a field reference, so a title
  containing `%(` would be read as one;
* Windows, which forbids several characters and gives up on paths past 260
  characters — reachable with a long title inside a long profile path.

Escaping correctly for all three, forever, is not worth attempting when
the title is not needed there at all.

### Changed

- **The download is named by Sipra, not by the track.** Each download goes
  into a directory of its own under a fixed short name with no character
  any layer treats as syntax. The title is read from the metadata, where
  it belongs and where it never has to survive a filesystem. This retires
  the whole family of faults rather than the one instance that was
  reported.
- **The path length no longer depends on the title.** It is a fixed
  twenty-three characters whatever the track is called, so the Windows
  ceiling cannot be reached by a long name.
- **Abandoned download folders are cleaned up on the way in.** A download
  that fails, is cancelled, or dies with the application cannot run a
  cleanup step — sweeping on entry covers the case a `finally` block
  cannot.
- **`unique_stem` is gone.** It existed only to reserve a title-derived
  filename, which no longer happens. Dead code with tests attached still
  costs maintenance.

### Fixed

- **Three tests that could not pass on Windows.** They wrote filenames
  containing `*` and `?`. Those characters can never reach a real filename
  — `safe_filename` removes them and the filesystem refuses them — so the
  property worth testing is that they are stripped, not that a file
  containing them can be found. That is what is tested now.

### Tests

- 639 TypeScript tests, 573 Python tests, and the Windows job passes.
- The download path is asserted to contain no glob metacharacter, no `%`,
  nothing Windows forbids, and no title. The lookup keeps its
  bracketed-name coverage regardless, because a lookup should not depend
  on the name being ours.
- The folder sweep: removes what is abandoned, leaves what may still be
  running, and never touches anything outside its own prefix.

### Housekeeping

- Every reference to the specific track used while debugging has been
  removed from the source, the tests and this changelog. Test fixtures use
  neutral names.

---

## [0.9.10] — 2026-08-24

Another import stuck on "Reading the file", this time with no log to read.

Every realistic download format was decoded here first — m4a, opus, WebM,
Ogg, MP3, FLAC — and all six worked. So this release does not claim to
have found the cause. It closes the two real gaps that inspection did
turn up, and makes the next occurrence explain itself instead of going
quiet.

### Fixed

- **WebM was refused outright.** YouTube's best audio stream is very often
  Opus inside WebM, and `.webm` was not on the list of extensions Sipra
  accepts — nor were `.mp4`, `.m4b`, `.mka` or `.mkv`. The decoder reads
  all of them; only the extension check turned them away. It never
  mattered while every download was forced to WAV, and started mattering
  the moment that stopped.
- **The two extension lists had drifted.** TypeScript and Python keep the
  same list twice, and only one of them was updated. The engine would have
  decoded a file that drag-and-drop refused to accept. There is a parity
  test now, running the real Python rather than reading its source, in the
  same shape as the one that guards the stem vocabulary.
- **A decoder trickling data was miscounted as producing none.** The read
  asked for a full megabyte and waited for it, so a slow decoder
  registered as silent until a whole chunk piled up — which made progress
  lurch and would eventually have had the new stall detector accuse a
  working decoder. It now takes whatever has arrived.

### Added

- **A stall detector.** The overall ceiling stays generous, because a long
  decode is legitimately long. Producing nothing at all is a different
  question with a much shorter answer: two minutes of complete silence and
  the decoder is given up on, with a message saying how far it got. Better
  than waiting out fifteen minutes to learn the same thing.
- **A heartbeat inside both decoders**, every five seconds, naming how far
  each has read. The last log stopped at "decoding <name>" and said
  nothing more; that gap is now filled from the inside.
- **A decoder whose output cannot be read is reported, not waited out.**
  If the thread draining the decoder's output dies, nothing is consuming
  it, so the decoder blocks writing and the job waits out its entire
  budget for a process that will never finish. That failure now surfaces
  immediately with the reason attached.

### Tests

- 639 TypeScript tests, 563 Python tests.
- **Real files in every format a download arrives in**, built with ffmpeg
  and put through the decoder unchanged — including under a bracketed
  title, since that is what broke the previous release. Correctness is
  checked by finding the tone in the spectrum rather than by measuring
  level: a non-zero peak proves only that bytes arrived, whereas the tone
  being where it was put proves the decode was right.
  **This coverage did not exist before.** Every existing test fed the
  decoder a WAV, so the ffmpeg path — the one every URL import now takes —
  had never been exercised with a real compressed file. Two releases
  shipped broken through that gap.
- Truncated files, files of pure noise, and cancellation mid-decode.
- The stall detector, and its counter-case: steady slow output must not be
  mistaken for a stall.
- CI now says out loud when ffmpeg is missing, so these tests skipping
  cannot quietly pass for a green run.

### Still open

If it stalls again, the log will now name the decoder, how many megabytes
it had read, and how long it sat — or the stall detector will have already
turned it into an error saying so. That is the report worth sending.

---

## [0.9.9] — 2026-08-24

"The download finished but no audio file was produced." It had been
produced. Sipra could not see it.

A regression from 0.9.8, and entirely self-inflicted. Dropping the forced
WAV conversion meant the downloaded file's extension is no longer known in
advance, so it is found afterwards by its stem — and that lookup used
`glob`, which reads `[`, `]`, `*` and `?` as pattern syntax. A YouTube
title lands in the filename intact, so a bracketed tag such as
"[HQ AUDIO]" became a pattern whose bracket expression matches a single
character. It matched nothing, and a completed download was reported as
having produced no file.

While every download was forced to WAV the exact path always existed and
that lookup was never reached, which is why the fault arrived with the fix
for the previous one.

### Fixed

- **A download whose title contains brackets is found again.** Filenames
  are now compared literally instead of being matched as patterns.
  Bracketed tags — `[Official Video]`, `[HQ AUDIO]`, `[4K]` — are close to
  universal on YouTube, so this was not an edge case; it broke a large
  share of real links.
- **`unique_stem` had the identical fault with a quieter symptom.** It
  reserves a filename by checking whether one is taken, and matching with
  `glob` meant a bracketed name reported everything as free — so it
  reserved nothing, and two similarly titled downloads could land on each
  other. Nobody had hit it yet.

### Tests

- 633 TypeScript tests, 534 Python tests. Both lookups are now exercised
  against every glob metacharacter a title can contain, including the
  failure in reverse — a pattern that matches a *different* file — plus
  work-in-progress extensions, directories sharing a name, and a stem that
  is merely a prefix of another.

### On this happening at all

The 0.9.8 change was right and this was avoidable. Removing the guarantee
that every download ended in `.wav` promoted a code path that had never
run in practice, and I did not test it against a realistic title. The
tests added here run against the names YouTube actually produces rather
than against `Song.m4a`.

---

## [0.9.8] — 2026-08-24

A YouTube import stopped at 30% on "Reading the file". The log's last line
was `decoding <the downloaded file>.wav | at=44100` and nothing after
it — decoding was a single opaque call, so the record stopped exactly
where it needed to keep going.

Two things were wrong. The file being read was a WAV that need never have
existed, and the code reading it could not be interrupted, could not
report, and had no deadline.

### Fixed

- **Downloads are no longer expanded to WAV.** yt-dlp was told
  `--audio-format wav`, which makes it run a second full ffmpeg pass
  turning a few megabytes of compressed audio into hundreds of megabytes
  of PCM — a file Sipra then decodes and immediately deletes. Every byte
  of it was wasted work, and reading it back was the step that appeared to
  stall. The audio is now kept as it arrives; the decoder reads m4a and
  opus perfectly well.
- **Neither the decoder nor the metadata probe had a timeout.** This is
  the same defect that hung an import back in 0.9.1, fixed then in the
  downloader and left untouched here. A decoder that stopped responding
  stopped the job with it, for as long as the app stayed open.
- **The downloader's own deadline was unreachable.** Its timeout sat on
  the `wait()` after the loop that reads yt-dlp's output, and that loop
  only ends when yt-dlp closes its output. A download that went quiet
  without exiting blocked in the read and never arrived at the timeout
  meant to catch precisely that. Both output streams are drained on their
  own threads now and the deadline is polled independently — which also
  means Cancel is noticed within half a second rather than whenever the
  next line happens to arrive.
- **MP3 export could wait forever too.** Found by the new audit rather
  than by anyone hitting it.

### Changed

- **Decoding reports progress and can be cancelled.** libsndfile is read a
  block at a time; ffmpeg's output is consumed in chunks against the
  expected size. "Reading the file" now moves, and Cancel works during it
  instead of waiting it out.
- The metadata probe also reads the duration, which is what makes the
  ffmpeg decode's progress a real fraction rather than a guess.

### Tests

- 633 TypeScript tests, 510 Python tests.
- **A static audit that every subprocess in the package can end.** It
  fails if any `subprocess.run` omits a timeout, if a file uses `Popen`
  without declaring that it manages its own deadline, or if a declared
  file stops enforcing one. This is the test that should have existed in
  0.9.1: fixing the file that was reported is not the same as fixing the
  fault, and the gap between those two cost this release.
- The audit found the MP3 export immediately, and the download loop's
  unreachable deadline.
- Block-by-block decoding is pinned sample-for-sample against a
  single-call read, so reading in pieces cannot quietly alter the audio.
- A stand-in decoder that produces nothing and never exits, proving the
  deadline fires; another that floods 512 KB to stderr, proving the
  drain-on-a-thread rule still holds here.

### A note on the same mistake twice

Writing the audit test caught me reintroducing this exact bug inside the
fix for it: the first version of the new decode loop checked its deadline
around a blocking read, which is not a deadline at all. The test hung, as
it should have.

---

## [0.9.7] — 2026-08-24

Two reports that turned out to be one fault, plus continuous integration.

The first track separated after installing would stop at around 36% and
stay there. Loading the same track again and cancelling the first one made
the second finish. Those two facts together are the diagnosis: nothing was
broken, the first attempt was paying a one-time cost with no way to say
so, and by the time the second attempt ran that cost had been paid.

36% is where the bar sits when decoding has finished and separation has
barely started. Two things happen in that gap, both only on a first run:
the model's weights are downloaded, and the first inference makes the
compute device compile its kernels. Neither reported anything, and the
download's own progress bar was captured and printed only after it had
finished — so the one piece of evidence that something was happening
appeared exactly when it was no longer needed.

### Fixed

- **The first separation after installing no longer pays for the model.**
  Setup now fetches the weights and runs a warm-up inference as its last
  step, with its own labelled progress. The first track behaves like every
  track after it. If setup cannot reach the network, this is skipped and
  the first separation fetches the weights as before — a machine that is
  offline at install time can still install.
- **Model preparation is a stage with a name.** `model` sits between
  decoding and separation, so the app says "Preparing the model" instead of
  showing a number that does not move. Its bar is deliberately
  indeterminate: the duration genuinely cannot be predicted, and inventing
  a fraction to look reassuring would be worse than admitting that.
- **Demucs' own output is relayed as it is produced.** It was collected
  into a buffer and printed when the call returned. A download's progress
  bar is worth nothing after the download. Carriage returns are treated as
  line breaks and the result is rate-limited, so a redrawing progress bar
  becomes a readable trail in the log rather than either silence or a
  flood.
- **Cancelling a stuck job no longer takes a queued job with it.** The
  workaround in the second report — queue another track, cancel the first
  — collided with the forced restart added in 0.9.6, which kills
  everything in flight. A job killed by a restart before it ever reported
  progress is now retried once. A job that had already reported progress
  is not: it may have been the wedged one, and re-running it would wedge
  again.

### Added

- **`models.prepare`**, which fetches, loads and warms a model on request.
  Used by setup; also available on its own.
- **Continuous integration in three workflows**, each with its own badge:
  TypeScript (typecheck, lint, tests, build), Python (ruff and tests
  across 3.10, 3.11 and 3.12), and Release (the full gate, then the
  installer). Windows and Ubuntu both, on every push and pull request.
- **The integration tests now actually run in CI.** They spawn a real
  Python process and drive it over a real pipe — the boundary where most
  of this project's real bugs have been — and they had been skipping
  themselves silently because the workflow never installed the Python
  core. A step now asserts they are enabled rather than trusting it.
- **`npm run set-repo`**, which points the badge URLs at a repository.
  Badge URLs carry the owner and repository name; until they are set they
  render as blank images with nothing to say why. Editing three by hand
  and getting one wrong produces exactly that, silently.
- **A one-line pass/fail summary on each CI run**, from Vitest's JSON
  report or pytest's JUnit XML.

### Tests

- 633 TypeScript tests, 487 Python tests. New coverage for the output
  relay (including that it never writes to stdout, which is the protocol
  channel), for model preparation and its progress reporting, and for both
  CI scripts — a summary parser that misreads a report would quietly claim
  a failing run passed, and a badge rewriter that misses a URL leaves a
  blank image forever.

---

## [0.9.6] — 2026-08-22

"I had to kill it." That answer matters more than the stall it described.
Cancel was there, and it did not work — so the fault was not only that a
job stopped, it was that stopping a job required ending the session. This
release makes Cancel able to stop something that has stopped listening.

### Fixed

- **Cancel could not stop a wedged job, and the engine never recovered
  from one.** Cancelling sets a flag the Python side checks between steps.
  A native call that has stopped responding — a numpy or scipy routine,
  which is what the reported stall turned out to be — never reaches a
  check, so the flag is never read. Heavy work runs one at a time by
  design, so from that moment every later separation queued behind a job
  that would never end, and the only way out was to kill the application.
  Cancel now waits eight seconds for the job to actually stop and, failing
  that, kills and restarts the engine. Requests in flight are rejected
  with a clear reason rather than left hanging, the library is untouched,
  and the next action starts a fresh engine.
- **A deliberately killed request reported itself as a crash.** It now
  says it was restarted, and why — in the log and in what the user is
  shown.

### Added

- **Free memory recorded at the two points it could matter**: immediately
  after separation, which is the high-water mark of the whole run, and
  before analysis. Read through Windows' own memory API and Linux's
  `/proc/meminfo`, no new dependency. The memory-pressure explanation for
  the 0.9.5 stall was a guess; the next log either supports it or kills it.
- **Every remaining numpy and scipy step announces itself** — the source
  copy, the source waveform, analysis start and finish. Everything after
  separation is the same kind of work as the call that hung, so if it
  happens again the log names which one rather than going quiet.
- **A notice when the engine is restarted**, so a job vanishing has a
  stated reason instead of looking like lost work.

### Tests

- 608 TypeScript tests, 474 Python tests. The wedged-job case is now
  reproducible: a test-only `debug.wedge` method occupies the worker while
  ignoring cancellation — registered only when the fixture engine is
  enabled, which never happens in a packaged build. The integration test
  drives a real sidecar over a real pipe: it wedges a job, cancels it,
  and asserts the engine restarts, the wedged request is rejected rather
  than abandoned, and a real separation runs afterwards. Plus the
  counter-case: a job that stops on its own must not trigger a restart.

---

## [0.9.5] — 2026-08-22

The log from 0.9.4 named the step. The last line before the stall was

    resampling the source copy | frm=48000 to=44100

and no line ever followed it. That conversion is measured at well under a
second on a track that size, so this release does not try to make it
faster — it removes the need for it.

### Fixed

- **The source copy was converted after separation, and that is where a
  job stopped.** Streaming audio arrives at 48 kHz and every model here
  works at 44.1 kHz, so the source had to be brought onto the stems'
  timebase or the playhead would drift between lanes. That was done after
  separation, holding the whole result set in memory, reporting nothing.
  Sipra now decodes straight to the model's declared rate, which makes the
  conversion unnecessary rather than merely faster: the engine no longer
  converts the input internally either, and where ffmpeg does the decoding
  it does the rate change while streaming, before any of it is resident.
- **A late progress report made the stage label go backwards.** The engine
  sent a closing `separate` after the bar had already moved on to
  `collect`, which is why the log reads "collect 84%, separate 85%, collect
  86%". A sequence that goes backwards invites the reader to distrust all
  of it, which is expensive when the log is the only evidence there is.

### Changed

- **A model now declares the rate it works at**, and the pipeline decodes
  to it. Previously the rate was discovered from the separation result,
  which is too late to act on.
- **Rate conversion is done one channel at a time**, which halves the peak
  allocation, and reports progress as it goes. The conversion that hung was
  a single allocation of the whole track made at the moment the process was
  holding the most memory it would hold all run — so this reduces the peak
  as well as making it visible.
- **The remaining post-separation conversion is a backstop**, reached only
  if an engine's actual output rate differs from what it declared. It
  traces and reports progress, so it can never again be an unexplained
  pause.

### Tests

- 605 TypeScript tests, 474 Python tests. The per-channel conversion is
  pinned sample-for-sample against the whole-array result, so halving the
  memory cannot quietly change the audio. The pipeline regression is
  asserted as the absence of a trace line that only exists on the
  post-separation branch, and stage ordering is checked end to end.

### Honest note

A conversion that takes half a second here took over a minute there, and
this release does not explain why. The most likely reading is memory
pressure — it ran at the point in the job holding the most memory, and it
allocated the whole track again — which is the same condition this change
relieves. But if the next stall lands somewhere else, the log will name
that step too.

---

## [0.9.4] — 2026-08-22

A separation that sits at 80% showing "Downloading audio". Four releases
have now shipped a fix for a job that appears frozen, and each one was a
hypothesis about a machine none of them could see. This release stops
guessing and builds the instrument instead: the app now keeps a record of
what it was doing and when, and the progress bar is made capable of
distinguishing the states it was conflating.

### Added

- **A diagnostic log**, always on, at `%APPDATA%\Sipra\logs\sipra.log`,
  rotating at 2 MB and keeping three copies. Every job event, every stage
  change, the duration of every call to the audio engine, and everything
  the Python side writes to its error stream. Reachable from a "Log"
  button on any job running longer than two minutes and from "Show the
  log" on an import failure. It is written to disk and nowhere else —
  `PRIVACY.md` says exactly what it contains.
- **A heartbeat for a job that is not moving.** Every 30 seconds a running
  job that has not changed writes a line saying how long it has been that
  way. A stall used to be a gap in the record, and a gap looks the same as
  the app having been closed; it is now a measurement.
- **Elapsed time next to each running job.** Separating a song on a CPU
  legitimately takes minutes. "Stuck" and "busy" were indistinguishable
  without a clock.
- **A heartbeat inside the model run.** Demucs' progress callback is now
  counted and sampled to the log every five seconds. The bar necessarily
  stops moving before the last segment finishes; these lines say whether
  the model is still working while it does.

### Fixed

- **The end of separation and the start of stem writing were the same
  number.** Both landed on exactly 0.80, so a bar frozen at 80% could mean
  the model was still finishing or that it had finished and the first stem
  was being written — different faults, one appearance. Moving each
  separated source off the compute device is now its own reported stage,
  `collect`, with the source resample given a band of its own inside it.
  Each of those steps now stalls at a different number.
- **A YouTube import's separation reported into a bar it did not own.**
  The download filled the first 30%, then separation reported its own
  0-100% into the same bar — and since the bar never moves backwards, it
  stood completely still until separation passed the one-third mark. On a
  slow machine that is minutes of a motionless bar with nothing wrong. The
  two halves are now scaled against one shared constant.
- **An import kept the label "Downloading audio" through separation**,
  which is how a job busy separating stems came to be reported as
  downloading. It takes the track's title once the download has produced
  one.
- **`formatElapsed` rendered `NaN:NaN`** for a job with no start time.
  Caught by its own test before it reached anything.

### Changed

- Stage tracing in the Python core is on by default rather than opt-in.
  It was off in packaged builds — the only place a stall has ever been
  reported — so the mechanism built to explain one was inert exactly where
  it was needed. `SIPRA_TRACE_STAGES=0` silences it.
- Each trace line carries the gap since the previous line, so the step
  that consumed the time is the one with a large number in front of it.

### Tests

- 605 TypeScript tests, 462 Python tests. New coverage for the log
  (rotation, partial-line streaming, throttling, the heartbeat's
  measurement of a stall, and every way the logger can fail without
  taking the app with it), for the download-to-separation handover
  including a counter-example that reproduces the old motionless bar, and
  for the callback counter that proves a model run is alive.

### Still unresolved

The cause of the original stall is not known, and this release does not
claim to fix it. What it changes is that the next occurrence leaves
evidence.

---

## [0.9.3] — 2026-08-22

The YouTube import still hung, now at "Checking the downloader — 1%".
That is `yt-dlp --version` — a call that answers in milliseconds from a
terminal. Since 0.9.1 hung on `--dump-single-json` and 0.9.2 hung on
`--version`, the hang follows the *first invocation of the binary*
whatever it is asked to do, which points at how the process is spawned
rather than what it is asked for.

### Fixed

- **Child processes inherited the sidecar's stdin.** None of the five
  places Sipra spawns a child — yt-dlp metadata, preflight, download,
  ffprobe, ffmpeg — set `stdin`. On Windows a child with no `stdin`
  argument inherits the parent's, and the sidecar's stdin is the NDJSON
  protocol pipe from Electron: a pipe that stays open for the life of the
  app and only ever carries request lines. A child that reads it steals
  protocol bytes; a child that blocks on it waits forever for input that
  is never coming. yt-dlp spawns ffmpeg, which reads stdin for keyboard
  commands unless told otherwise, so the inheritance reaches two processes
  deep. Every spawn site now passes `stdin=subprocess.DEVNULL`.
- **A user's yt-dlp config file could change what Sipra ran.**
  `%APPDATA%\yt-dlp\config` is read by default, and an option there —
  `--wait-for-video`, an interactive `--cookies-from-browser`, a proxy —
  applies to Sipra's invocations too, invisibly. All invocations now pass
  `--ignore-config`, so what Sipra runs is what Sipra asked for.

### Added

- **`python -m sipra_core ytdlp-check`.** Probes the downloader from a
  terminal and prints what it found, so the check can be run outside the
  app when the app is the thing that appears stuck.
- **A faster downloader diagnosis.** "Check the downloader" in the import
  dialog now probes directly with a 25-second ceiling instead of going
  through the cached preflight, so the diagnosis answers quickly even when
  the preflight is the call that hangs.
- **`SIPRA_TRACE_STAGES=1`** logs each separation stage as it is entered,
  for narrowing down a stall that only happens on one machine.

### Tests

- A static test walks every `.py` in the package, extracts the argument
  list of every `subprocess.run`/`Popen` call, and fails if any of them
  omits `stdin`. A new spawn site cannot regress this quietly.
- A fake downloader that calls `sys.stdin.read()` before answering
  `--version`. It hangs the pre-0.9.3 spawn and passes now.

### Changed

- Per-call timeout overrides: `SIPRA_YTDLP_METADATA_TIMEOUT`,
  `SIPRA_YTDLP_PREFLIGHT_TIMEOUT`, `SIPRA_YTDLP_DIAGNOSE_TIMEOUT`,
  `SIPRA_YTDLP_DOWNLOAD_TIMEOUT`.
- The hint list shown with a downloader failure now leads with "run the
  downloader yourself from a terminal" — the one check that separates a
  Sipra problem from a machine problem.

---

## [0.9.2] — 2026-08-22

A YouTube import that showed "Downloading audio — Waiting — 0%" and never
moved. Three distinct causes, found by following that one symptom.

### Fixed

- **A running job rendered with its queued label.** `JobRegistry.start`
  set the status to `running` but left `progress.stage` as `queued`, and
  the panel labels from the stage. So a job that was actively working
  displayed "Waiting" at 0% — indistinguishable from stuck. The stage now
  advances when the job starts, and an already-reported stage is left
  alone.
- **Nothing was reported before a download began.** `download_audio` runs
  a preflight and a metadata request first, both of which can take a while
  on a cold machine, and emitted no progress for either. Those phases now
  report as "Checking the downloader" and "Reading the link".
- **A deadlock in the download reader.** stdout was read to EOF while
  stderr sat unread. Once yt-dlp had written a pipe buffer's worth of
  warnings — about 64 KB, which it reaches easily — it blocked writing,
  while Sipra was blocked reading stdout. Nothing timed out, because the
  `wait()` carrying the timeout was never reached. stderr is now drained
  on its own thread. The regression test floods 512 KB and is verified to
  hang the old read pattern.

### Changed

- A running job with nothing to report yet shows a moving bar rather than
  a flat 0%, which reads as progress rather than as a stall. It respects
  `prefers-reduced-motion`.
- The download timeout message now names the limit and carries yt-dlp's
  stderr instead of saying only "The download timed out."

---

## [0.9.1] — 2026-08-22

Both fixes here came from the first real run on Windows. Neither had test
coverage, which is why they shipped.

### Fixed

- **A yt-dlp timeout surfaced as "Unexpected failure: Command [...] timed
  out after 60 seconds".** `subprocess.TimeoutExpired` was never caught in
  `fetch_metadata`, so it fell through to the generic handler and reached
  the user as a raw Python string naming no cause and suggesting no
  remedy. Process-level failures are now converted into explained errors
  that say what was being attempted and what to try.
- **The progress bar sat at exactly 80% for the whole stem-writing
  stage.** 80% is the boundary between `separate` and `write` in the stage
  weights. The write loop reported only on completion of each stem, so
  between "separation finished" and "first stem written" — tens of
  megabytes of clipping, transposing and disk I/O per stem on a real
  track — nothing was emitted at all. Progress is now reported at the
  start, middle and end of each stem.

### Changed

- **Stems are released as soon as they reach disk.** The whole set was
  held in memory for the duration of the write loop, alongside the source
  and whatever the engine had not yet freed. On a six-stem separation of a
  long track that is enough to push a modest machine into swap, which is
  what turns a slow stage into an apparently frozen one.
- **A link with no video id is now rejected instantly.** `…/watch?v=` with
  nothing after it — a link truncated on its way through a chat client —
  was handed to yt-dlp, which sat on it until the timeout fired. Video ids
  are validated before anything is spawned.
- **yt-dlp is given `--socket-timeout` and `--retries`.** Without them it
  waits on a half-open socket until Sipra's own timeout fires, which
  disguises a routing problem as an unexplained hang.
- **Timeouts raised, and the startup cost paid separately.** The Windows
  yt-dlp is a PyInstaller bundle that unpacks ~17 MB into `%TEMP%` on its
  first run, with antivirus watching. That alone could exceed the old 60 s
  metadata timeout. A one-off preflight now absorbs it, and the timeouts
  are overridable via `SIPRA_YTDLP_METADATA_TIMEOUT` and friends.
- **`Sidecar.configure` merges instead of replacing.** It was called once
  the Python path was known and silently dropped the `onStderr` handler
  set up at construction, taking the engine's diagnostics with it.

### Added

- **A downloader check in the import dialog.** Reports whether yt-dlp is
  present, whether it starts, whether it can reach YouTube, and what to
  try — because "it timed out" is not something anyone can act on, and
  those three failures need three different responses.
- **Stage tracing.** `SIPRA_TRACE_STAGES=1` makes each pipeline stage
  announce itself on stderr with a timestamp, so a stalled job can be
  located rather than guessed at. On by default in development.
- `SIPRA_YTDLP_FORCE_IPV4=1` for machines with a half-configured IPv6
  stack, a common cause of exactly this class of hang.
- Regression tests for every path above, including the timeout that
  started it.

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

[0.9.2]: https://github.com/OWNER/sipra/releases/tag/v0.9.2
[0.9.1]: https://github.com/OWNER/sipra/releases/tag/v0.9.1
[0.9.0]: https://github.com/OWNER/sipra/releases/tag/v0.9.0
[0.8.0]: https://github.com/OWNER/sipra/releases/tag/v0.8.0
[0.7.0]: https://github.com/OWNER/sipra/releases/tag/v0.7.0
[0.6.0]: https://github.com/OWNER/sipra/releases/tag/v0.6.0
[0.5.0]: https://github.com/OWNER/sipra/releases/tag/v0.5.0
[0.4.0]: https://github.com/OWNER/sipra/releases/tag/v0.4.0
[0.3.0]: https://github.com/OWNER/sipra/releases/tag/v0.3.0
[0.2.0]: https://github.com/OWNER/sipra/releases/tag/v0.2.0
[0.1.0]: https://github.com/OWNER/sipra/releases/tag/v0.1.0
