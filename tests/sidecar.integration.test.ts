/**
 * End-to-end test of the Electron ↔ Python boundary.
 *
 * Unlike every other test here, this one spawns the real sidecar and
 * drives it over a real pipe. Mocks cannot catch the failures this
 * boundary actually has: a dependency printing to stdout, a non-ASCII
 * track title, a partial line split across a chunk, a job that never
 * answers.
 *
 * It runs only when a Python with the core's dependencies is available,
 * and skips otherwise, so the TypeScript suite still passes on a machine
 * without one. The fixture engine stands in for Demucs, so no PyTorch is
 * needed.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { decodePeaks } from '@shared/peaks';
import { Sidecar, SidecarError } from '../electron/services/sidecar';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonDir = path.join(repoRoot, 'python');

/** Find a Python that can import the core, or null. */
function findPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['-c', 'import sipra_core, numpy, soundfile, scipy'], {
        cwd: pythonDir,
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const python = findPython();
const describeIf = python ? describe : describe.skip;

/**
 * Budgets for a slow runner, not for this machine.
 *
 * A Windows CI runner is roughly ten times slower here than a developer
 * machine, and the first analysis in a fresh process additionally compiles
 * part of librosa — tens of seconds on its own. Budgets tuned locally
 * turned that into seven failures, only one of which was a real fault: the
 * first `separate` overran, and because heavy work runs one at a time in
 * the engine, everything after it queued behind a job nobody was waiting
 * for any more.
 *
 * These are deliberately generous. A test that fails only on the slowest
 * supported platform teaches nothing except to distrust the suite.
 */
const SHORT = 60_000;
const LONG = 300_000;
const WARMUP = 600_000;

// Every test in this file talks to a real process over a real pipe, so
// none of them belong on the default five-second budget. Three of the
// seven CI failures were tests that do nothing but check an argument is
// rejected — they simply never got a turn inside five seconds while the
// engine was busy. Individual `it` timeouts still raise this where a test
// genuinely needs longer.
vi.setConfig({ testTimeout: SHORT, hookTimeout: WARMUP });

describeIf('sidecar integration', () => {
  let workspace: string;
  let sidecar: Sidecar;
  let sourcePath: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-e2e-'));

    // A short signal with content in several bands, written with the same
    // library the core reads it back with.
    sourcePath = path.join(workspace, 'Café ☃ test.wav');
    execFileSync(
      python as string,
      [
        '-c',
        [
          'import sys, numpy as np, soundfile as sf',
          'sr = 44100',
          't = np.arange(int(sr * 2.0)) / sr',
          'sig = (0.4*np.sin(2*np.pi*110*t) + 0.3*np.sin(2*np.pi*880*t) '
          + '+ 0.15*np.sin(2*np.pi*5000*t)).astype("float32")',
          'sf.write(sys.argv[1], np.stack([sig, sig*0.9]).T, sr, subtype="FLOAT")',
        ].join('\n'),
        sourcePath,
      ],
      { cwd: pythonDir },
    );

    sidecar = new Sidecar({
      pythonPath: python as string,
      cwd: pythonDir,
      env: { SIPRA_ENABLE_FIXTURE_ENGINE: '1' },
    });
    await sidecar.start();
  }, WARMUP);

  afterAll(async () => {
    await sidecar?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('starts and answers a ping', async () => {
    const result = await sidecar.request<{ pong: boolean; protocolVersion: number }>('ping');
    expect(result.pong).toBe(true);
    expect(result.protocolVersion).toBe(1);
  });

  it('agrees with the TypeScript client on the protocol version', async () => {
    // A bump on one side without the other is exactly the kind of drift
    // this boundary is prone to.
    const { protocolVersion } = await sidecar.request<{ protocolVersion: number }>('capabilities');
    expect(protocolVersion).toBe(1);
  });

  it('reports its capabilities', async () => {
    const capabilities = await sidecar.request<{
      engines: Array<{ id: string; available: boolean }>;
      stems: Array<{ id: string; experimental: boolean }>;
      supportedExtensions: string[];
    }>('capabilities');

    expect(capabilities.engines.some((engine) => engine.id === 'fixture')).toBe(true);
    expect(capabilities.supportedExtensions).toContain('.wav');
    const piano = capabilities.stems.find((stem) => stem.id === 'piano');
    expect(piano?.experimental).toBe(true);
  });

  it('probes a file with a non-ASCII name', async () => {
    // A name with an accent in it is where naive stream decoding breaks.
    const info = await sidecar.request<{ channels: number; durationSeconds: number }>('probe', {
      path: sourcePath,
    });
    expect(info.channels).toBe(2);
    expect(info.durationSeconds).toBeCloseTo(2.0, 1);
  });

  it('returns a structured error for a missing file', async () => {
    await expect(sidecar.request('probe', { path: path.join(workspace, 'nope.wav') })).rejects
      .toThrow(SidecarError);

    try {
      await sidecar.request('probe', { path: path.join(workspace, 'nope.wav') });
      expect.unreachable();
    } catch (error) {
      expect((error as SidecarError).code).toBe('FILE_NOT_FOUND');
    }
  });

  it('rejects an unknown method with the list of known ones', async () => {
    try {
      await sidecar.request('does.not.exist');
      expect.unreachable();
    } catch (error) {
      expect((error as SidecarError).code).toBe('UNKNOWN_METHOD');
      expect((error as SidecarError).details.known).toContain('separate');
    }
  });

  it('validates parameters', async () => {
    try {
      await sidecar.request('probe', {});
      expect.unreachable();
    } catch (error) {
      expect((error as SidecarError).code).toBe('INVALID_PARAMS');
    }
  });

  it('separates a track, reporting progress that ends at one', async () => {
    const fractions: number[] = [];
    const onProgress = (data: unknown): void => {
      const payload = data as { jobId?: string; fraction?: number };
      if (payload?.jobId === 'e2e-job') fractions.push(payload.fraction ?? 0);
    };
    sidecar.on('progress', onProgress);

    try {
      const outcome = await sidecar.request<{
        stems: Array<{ id: string; audioPath: string; peaksPath: string }>;
        sourcePeaksPath: string;
        durationSeconds: number;
        analysis: { bpm: number | null; integratedLufs: number | null } | null;
      }>(
        'separate',
        {
          path: sourcePath,
          outputDir: path.join(workspace, 'track'),
          engine: 'fixture',
          model: 'fixture-4',
          analyse: true,
          jobId: 'e2e-job',
        },
        LONG,
      );

      expect(outcome.stems.map((stem) => stem.id)).toEqual(['vocals', 'drums', 'bass', 'other']);
      expect(outcome.durationSeconds).toBeCloseTo(2.0, 1);
      expect(outcome.analysis?.integratedLufs).toBeTypeOf('number');

      for (const stem of outcome.stems) {
        await expect(fs.access(stem.audioPath)).resolves.toBeUndefined();
        await expect(fs.access(stem.peaksPath)).resolves.toBeUndefined();
      }

      expect(fractions.length).toBeGreaterThan(0);
      expect([...fractions]).toEqual([...fractions].sort((a, b) => a - b));
      expect(fractions.at(-1)).toBeCloseTo(1, 5);
    } finally {
      sidecar.off('progress', onProgress);
    }
  }, LONG);

  it('writes peak files the TypeScript decoder can read', async () => {
    // The binary layout is defined in Python and parsed in TypeScript;
    // this is the only test that proves the two agree.
    const peaksPath = path.join(workspace, 'track', 'peaks', 'vocals.speaks');
    const payload = await fs.readFile(peaksPath);
    const peaks = decodePeaks(
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    );

    expect(peaks.sampleRate).toBe(44100);
    expect(peaks.bucketCount).toBeGreaterThan(0);
    expect(peaks.durationSeconds).toBeCloseTo(2.0, 1);
    expect(Math.max(...Array.from(peaks.maxima))).toBeGreaterThan(0);
  });

  it('exports a mix from the separated stems', async () => {
    const target = path.join(workspace, 'mix.wav');
    const result = await sidecar.request<{ path: string; stemCount: number; clipped: boolean }>(
      'mix.export',
      {
        tracks: [
          { path: path.join(workspace, 'track', 'stems', 'vocals.wav'), gainDb: 0 },
          { path: path.join(workspace, 'track', 'stems', 'bass.wav'), gainDb: -6 },
        ],
        outputPath: target,
        format: 'wav',
        bitDepth: 24,
      },
      LONG,
    );

    expect(result.stemCount).toBe(2);
    await expect(fs.access(result.path)).resolves.toBeUndefined();
  }, LONG);

  it('refuses a URL import without the rights confirmation', async () => {
    try {
      await sidecar.request('youtube.download', {
        url: 'https://youtube.com/watch?v=abc',
        destinationDir: workspace,
        rightsConfirmed: false,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as SidecarError).code).toBe('RIGHTS_NOT_CONFIRMED');
    }
  });

  it('refuses a URL outside the allowlist', async () => {
    try {
      await sidecar.request('youtube.download', {
        url: 'https://evil.example/watch?v=abc',
        destinationDir: workspace,
        rightsConfirmed: true,
      });
      expect.unreachable();
    } catch (error) {
      expect(['UNSUPPORTED_URL', 'DOWNLOADER_UNAVAILABLE']).toContain(
        (error as SidecarError).code,
      );
    }
  });

  it('reports an unknown job as already stopped', async () => {
    // `cancel` answers "is this job still running", not "did the engine
    // recognise it". Nothing is running under that id, so there is nothing
    // to wait for and nothing to restart.
    expect(await sidecar.cancel('no-such-job')).toBe(true);
  });

  it('stays responsive to a ping while a job is running', async () => {
    // The worker is separate from the reader thread precisely so a long
    // separation cannot block a cancel.
    const job = sidecar.request(
      'separate',
      {
        path: sourcePath,
        outputDir: path.join(workspace, 'track2'),
        engine: 'fixture',
        model: 'fixture-6',
        analyse: false,
        jobId: 'busy-job',
      },
      180_000,
    );

    const pong = await sidecar.request<{ pong: boolean }>('ping', {}, SHORT);
    expect(pong.pong).toBe(true);
    await job;
  }, LONG);
});

/**
 * What happens when a job will not stop.
 *
 * Cancellation sets a flag the Python side checks between steps. A native
 * call that has stopped responding — a numpy or scipy routine, which is
 * what a real stall turned out to be — never reaches a check, so the flag
 * is never read. Heavy work runs one at a time, so from that moment the
 * engine is finished for the session: every later separation queues behind
 * a job that will never end. The only fix is to kill the process, and a
 * user should not have to be the one who works that out.
 *
 * `debug.wedge` stands in for that native call. It exists only when the
 * fixture engine is enabled, which is never true in a packaged build.
 */
describeIf('cancelling a job that will not stop', () => {
  let workspace: string;
  let wedged: Sidecar;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-wedge-'));
    wedged = new Sidecar({
      pythonPath: python as string,
      cwd: pythonDir,
      env: { SIPRA_ENABLE_FIXTURE_ENGINE: '1' },
      // Shortened so the test does not sit out the real grace period.
      cancelGraceMs: 1500,
    });
    await wedged.start();
  }, LONG);

  afterAll(async () => {
    await wedged?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('restarts the engine and leaves it usable', async () => {
    const restarts: string[] = [];
    wedged.on('restarting', ({ reason }: { reason: string }) => restarts.push(reason));

    const stuck = wedged.request('debug.wedge', { jobId: 'wedged-job', seconds: 120 }, LONG);
    // Let it reach the worker before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(wedged.hasPendingFor('wedged-job')).toBe(true);

    const stoppedCleanly = await wedged.cancel('wedged-job');
    expect(stoppedCleanly).toBe(false);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toContain('wedged-job');

    // The wedged request is rejected rather than left hanging forever.
    await expect(stuck).rejects.toMatchObject({ code: 'SIDECAR_RESTARTED' });

    // And the engine works again — which is the whole point. Before this,
    // one wedged job ended the session.
    const pong = await wedged.request<{ pong: boolean }>('ping', {}, SHORT);
    expect(pong.pong).toBe(true);
  }, LONG);

  it('runs a real job after a restart', async () => {
    const outcome = await wedged.request<{ stems: unknown[] }>(
      'separate',
      {
        path: sharedSource(workspace, python as string),
        outputDir: path.join(workspace, 'after-restart'),
        engine: 'fixture',
        model: 'fixture-4',
        analyse: false,
        jobId: 'after-restart',
      },
      180_000,
    );
    expect(outcome.stems).toHaveLength(4);
  }, LONG);

  it('frees the engine when a caller gives up waiting', async () => {
    // Giving up on an answer does not stop the work. Heavy methods run one
    // at a time, so a request abandoned by its caller used to leave the
    // engine occupied and every later job queued behind one nobody wanted
    // any more. That is what turned a single slow test into seven failures
    // in CI. A timed-out request now cancels its own job.
    const restarts: string[] = [];
    wedged.on('restarting', ({ reason }: { reason: string }) => restarts.push(reason));

    await expect(
      wedged.request(
        'debug.wedge',
        { jobId: 'abandoned', seconds: 120, ignoreCancel: false },
        2_000,
      ),
    ).rejects.toMatchObject({ code: 'SIDECAR_TIMEOUT' });

    // The proof: the next job runs promptly instead of queueing behind a
    // two-minute sleep nobody is waiting for.
    const started = Date.now();
    const pong = await wedged.request<{ pong: boolean }>('debug.wedge', { seconds: 0.1 }, SHORT);
    expect(pong).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(30_000);

    // And it was freed by cancelling, not by killing the engine.
    expect(restarts).toHaveLength(0);
  }, LONG);

  it('does not restart when the job stops on its own', async () => {
    const restarts: string[] = [];
    wedged.on('restarting', ({ reason }: { reason: string }) => restarts.push(reason));
    // Short enough to finish inside the grace period.
    await wedged.request('debug.wedge', { jobId: 'brief', seconds: 0.2 }, SHORT);
    expect(await wedged.cancel('brief')).toBe(true);
    expect(restarts).toHaveLength(0);
  }, LONG);
});

/**
 * A restart, with the old process dying slowly.
 *
 * Killing a process does not make it go quiet at once: its exit event and
 * any buffered output arrive whenever the operating system gets to them.
 * On a slow machine that lands *after* a replacement has been spawned, and
 * every handler attached to the old process writes to state shared with
 * whatever is current — so the corpse could mark the live engine dead.
 *
 * The result was "the audio engine did not answer in time" for every job
 * after a restart, on a healthy engine that was listening the whole while.
 * Setting the grace to zero guarantees that ordering here instead of
 * waiting for a slow machine to produce it.
 */
describeIf('a restart whose old process reports late', () => {
  let workspace: string;
  let sidecar: Sidecar;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-late-'));
    sidecar = new Sidecar({
      pythonPath: python as string,
      cwd: pythonDir,
      env: { SIPRA_ENABLE_FIXTURE_ENGINE: '1' },
      cancelGraceMs: 1500,
      // Do not wait for the old process at all: the replacement is spawned
      // while it is still dying, which is the case being tested.
      restartExitGraceMs: 0,
    });
    await sidecar.start();
  }, WARMUP);

  afterAll(async () => {
    await sidecar?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('still answers async requests afterwards', async () => {
    await sidecar.restart('deliberate, for the test');
    const result = await sidecar.request<{ wedged: boolean }>(
      'debug.wedge',
      { seconds: 0.1 },
      SHORT,
    );
    expect(result.wedged).toBe(true);
  }, LONG);

  it('survives being restarted repeatedly', async () => {
    // Each restart leaves another process dying in the background, so this
    // is where a stale handler would accumulate its damage.
    for (let round = 0; round < 3; round += 1) {
      await sidecar.restart(`round ${round}`);
      const pong = await sidecar.request<{ pong: boolean }>('ping', {}, SHORT);
      expect(pong.pong).toBe(true);
    }
    const result = await sidecar.request<{ wedged: boolean }>(
      'debug.wedge',
      { seconds: 0.1 },
      SHORT,
    );
    expect(result.wedged).toBe(true);
  }, LONG);

  it('runs a real separation after a restart', async () => {
    await sidecar.restart('deliberate, for the test');
    const outcome = await sidecar.request<{ stems: unknown[] }>(
      'separate',
      {
        path: sharedSource(workspace, python as string),
        outputDir: path.join(workspace, 'after-late-exit'),
        engine: 'fixture',
        model: 'fixture-4',
        analyse: false,
        jobId: 'after-late-exit',
      },
      LONG,
    );
    expect(outcome.stems).toHaveLength(4);
  }, LONG);
});

/** Write the shared test signal into `dir` once, returning its path. */
function sharedSource(dir: string, pythonExe: string): string {
  const target = path.join(dir, 'signal.wav');
  execFileSync(
    pythonExe,
    [
      '-c',
      [
        'import sys, numpy as np, soundfile as sf',
        'sr = 44100',
        't = np.arange(int(sr * 1.5)) / sr',
        'sig = (0.4*np.sin(2*np.pi*110*t) + 0.3*np.sin(2*np.pi*880*t)).astype("float32")',
        'sf.write(sys.argv[1], np.stack([sig, sig]).T, sr, subtype="FLOAT")',
      ].join('\n'),
      target,
    ],
    { cwd: pythonDir },
  );
  return target;
}
