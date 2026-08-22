/**
 * How a job made of several sidecar calls reports one bar.
 *
 * A YouTube import is a download and then a separation. Each call reports
 * its own 0 to 1, and the job registry refuses to move the bar backwards,
 * so getting the handover wrong does not show up as a jump — it shows up
 * as the bar standing still. That is indistinguishable from the app having
 * stopped, which is the fault this arithmetic exists to avoid.
 */

import { describe, expect, it } from 'vitest';

import { JobRegistry } from '../electron/services/jobs';
import { DOWNLOAD_SHARE, scaleProgress } from '../electron/services/workspace';

describe('scaleProgress', () => {
  it('is the identity over the whole bar', () => {
    expect(scaleProgress(0, 0, 1)).toBe(0);
    expect(scaleProgress(0.42, 0, 1)).toBeCloseTo(0.42);
    expect(scaleProgress(1, 0, 1)).toBe(1);
  });

  it('maps a stage onto its own slice', () => {
    expect(scaleProgress(0, 0.3, 1)).toBeCloseTo(0.3);
    expect(scaleProgress(0.5, 0.3, 1)).toBeCloseTo(0.65);
    expect(scaleProgress(1, 0.3, 1)).toBeCloseTo(1);
  });

  it('clamps a fraction outside the unit interval', () => {
    expect(scaleProgress(-1, 0.3, 1)).toBeCloseTo(0.3);
    expect(scaleProgress(2, 0.3, 1)).toBeCloseTo(1);
  });

  it('treats a missing or unreal fraction as the start of the slice', () => {
    expect(scaleProgress(undefined, 0.3, 1)).toBeCloseTo(0.3);
    expect(scaleProgress(Number.NaN, 0.3, 1)).toBeCloseTo(0.3);
    expect(scaleProgress(Number.POSITIVE_INFINITY, 0.3, 1)).toBeCloseTo(0.3);
  });

  it('is monotonic across its slice', () => {
    const seen = [0, 0.1, 0.25, 0.5, 0.75, 0.99, 1].map((f) => scaleProgress(f, 0.3, 1));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('the download to separation handover', () => {
  it('leaves no gap the bar would have to jump across', () => {
    const endOfDownload = 1 * DOWNLOAD_SHARE;
    const startOfSeparation = scaleProgress(0, DOWNLOAD_SHARE, 1);
    expect(startOfSeparation).toBeCloseTo(endOfDownload);
  });

  it('advances the bar as soon as separation starts reporting', () => {
    // The regression: separation used to report into the bar unscaled, so
    // the first third of it moved nothing at all.
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'download', label: 'Downloading audio' });
    registry.start(job.id);
    registry.progress(job.id, 'download', 1 * DOWNLOAD_SHARE);
    const atHandover = registry.get(job.id)?.progress.fraction ?? 0;

    registry.progress(job.id, 'decode', scaleProgress(0.06, DOWNLOAD_SHARE, 1));
    expect(registry.get(job.id)?.progress.fraction).toBeGreaterThan(atHandover);
  });

  it('would have stalled under the old unscaled mapping', () => {
    // Kept as the counter-example: the same events, reported unscaled,
    // leave the bar exactly where the download left it.
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'download', label: 'Downloading audio' });
    registry.start(job.id);
    registry.progress(job.id, 'download', DOWNLOAD_SHARE);
    for (const fraction of [0.06, 0.1, 0.2, 0.29]) {
      registry.progress(job.id, 'separate', fraction);
    }
    expect(registry.get(job.id)?.progress.fraction).toBeCloseTo(DOWNLOAD_SHARE);
  });

  it('reaches the end of the bar when separation completes', () => {
    expect(scaleProgress(1, DOWNLOAD_SHARE, 1)).toBeCloseTo(1);
  });
});
