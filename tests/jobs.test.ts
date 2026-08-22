import { describe, expect, it, vi } from 'vitest';

import { COMPLETED_HISTORY, JobRegistry } from '../electron/services/jobs';

describe('JobRegistry', () => {
  it('creates a queued job', () => {
    const job = new JobRegistry().create({ kind: 'separate', label: 'Song.wav' });
    expect(job.status).toBe('queued');
    expect(job.progress.fraction).toBe(0);
    expect(job.startedAt).toBeNull();
    expect(job.id).toBeTruthy();
  });

  it('accepts a caller-supplied id', () => {
    const job = new JobRegistry().create({ kind: 'analyze', label: 'x', id: 'fixed' });
    expect(job.id).toBe('fixed');
  });

  it('marks a job running and stamps the start time', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    const started = registry.start(job.id);
    expect(started?.status).toBe('running');
    expect(started?.startedAt).not.toBeNull();
  });

  it('records progress', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    const updated = registry.progress(job.id, 'separate', 0.42);
    expect(updated?.progress).toEqual({ stage: 'separate', fraction: 0.42 });
    expect(updated?.status).toBe('running');
  });

  it('never lets the bar move backwards', () => {
    // A bar that jumps back reads as a bug even when the work is fine.
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    registry.progress(job.id, 'separate', 0.8);
    expect(registry.progress(job.id, 'separate', 0.2)?.progress.fraction).toBe(0.8);
  });

  it('clamps progress to the unit interval', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    expect(registry.progress(job.id, 's', 5)?.progress.fraction).toBe(1);
    const other = registry.create({ kind: 'separate', label: 'y' });
    expect(registry.progress(other.id, 's', -3)?.progress.fraction).toBe(0);
    const third = registry.create({ kind: 'separate', label: 'z' });
    expect(registry.progress(third.id, 's', Number.NaN)?.progress.fraction).toBe(0);
  });

  it('ignores progress arriving after the job finished', () => {
    // A late event must not resurrect a cancelled job's bar.
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    registry.cancel(job.id);
    registry.progress(job.id, 'separate', 0.9);
    expect(registry.get(job.id)?.status).toBe('cancelled');
  });

  it('completes a job at full progress', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    const done = registry.succeed(job.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.progress.fraction).toBe(1);
    expect(done?.finishedAt).not.toBeNull();
  });

  it('records a failure with its error', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    const failed = registry.fail(job.id, { code: 'BOOM', message: 'exploded' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('BOOM');
  });

  it('does not leave a failed bar at 100%', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    registry.progress(job.id, 'separate', 0.4);
    expect(registry.fail(job.id, { code: 'X', message: 'y' })?.progress.fraction).toBe(0.4);
  });

  it('refuses to cancel an already-finished job', () => {
    const registry = new JobRegistry();
    const job = registry.create({ kind: 'separate', label: 'x' });
    registry.succeed(job.id);
    expect(registry.cancel(job.id)?.status).toBe('succeeded');
  });

  it('returns undefined for an unknown id', () => {
    const registry = new JobRegistry();
    expect(registry.start('ghost')).toBeUndefined();
    expect(registry.progress('ghost', 's', 0.5)).toBeUndefined();
    expect(registry.succeed('ghost')).toBeUndefined();
    expect(registry.cancel('ghost')).toBeUndefined();
  });

  it('lists jobs newest first even when created in the same millisecond', () => {
    // Dropping several files at once creates their jobs within one tick.
    const registry = new JobRegistry();
    const created = Array.from({ length: 5 }, (_value, index) =>
      registry.create({ kind: 'separate', label: `job-${index}` }),
    );
    expect(registry.list().map((job) => job.label)).toEqual(
      [...created].reverse().map((job) => job.label),
    );
  });

  it('separates active jobs from finished ones', () => {
    const registry = new JobRegistry();
    const running = registry.create({ kind: 'separate', label: 'a' });
    const done = registry.create({ kind: 'separate', label: 'b' });
    registry.succeed(done.id);
    expect(registry.active().map((job) => job.id)).toEqual([running.id]);
  });

  it('emits an update for every change', () => {
    const registry = new JobRegistry();
    const listener = vi.fn();
    registry.on('updated', listener);
    const job = registry.create({ kind: 'separate', label: 'x' });
    registry.start(job.id);
    registry.progress(job.id, 'separate', 0.5);
    registry.succeed(job.id);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('prunes old finished jobs but keeps active ones', () => {
    const registry = new JobRegistry();
    const active = registry.create({ kind: 'separate', label: 'active' });
    for (let index = 0; index < COMPLETED_HISTORY + 10; index += 1) {
      const job = registry.create({ kind: 'separate', label: `job-${index}` });
      registry.succeed(job.id);
    }
    expect(registry.get(active.id)).toBeDefined();
    const finished = registry.list().filter((job) => job.status === 'succeeded');
    expect(finished.length).toBeLessThanOrEqual(COMPLETED_HISTORY);
  });

  it('clears finished jobs on request', () => {
    const registry = new JobRegistry();
    const active = registry.create({ kind: 'separate', label: 'a' });
    const done = registry.create({ kind: 'separate', label: 'b' });
    registry.succeed(done.id);
    registry.clearFinished();
    expect(registry.list().map((job) => job.id)).toEqual([active.id]);
  });
});
