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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  }, 120_000);

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
        180_000,
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
  }, 180_000);

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
      120_000,
    );

    expect(result.stemCount).toBe(2);
    await expect(fs.access(result.path)).resolves.toBeUndefined();
  }, 120_000);

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

  it('reports an unknown job as not cancellable', async () => {
    expect(await sidecar.cancel('no-such-job')).toBe(false);
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

    const pong = await sidecar.request<{ pong: boolean }>('ping', {}, 30_000);
    expect(pong.pong).toBe(true);
    await job;
  }, 180_000);
});
