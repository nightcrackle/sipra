/**
 * Job bookkeeping.
 *
 * The sidecar runs one heavy task at a time; this keeps the queue, tracks
 * status and progress, and gives the UI something to render and cancel.
 * Completed jobs are kept briefly so a user who looks away does not come
 * back to an empty panel wondering whether anything happened.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { Job, JobKind, JobStatus, SipraErrorPayload } from '../../shared/types';

/** How many finished jobs to keep in the list. */
export const COMPLETED_HISTORY = 25;

export interface CreateJobInput {
  kind: JobKind;
  label: string;
  trackId?: string | null;
  id?: string;
}

export class JobRegistry extends EventEmitter {
  private readonly jobs = new Map<string, Job>();

  /**
   * Insertion order, used to break ties on `createdAt`.
   *
   * Dropping several files at once creates their jobs inside the same
   * millisecond, so sorting on the timestamp alone leaves them in
   * whatever order the stable sort happened to preserve — which is
   * oldest-first, the opposite of what the panel should show.
   */
  private readonly sequence = new Map<string, number>();
  private nextSequence = 0;

  create(input: CreateJobInput): Job {
    const job: Job = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      label: input.label,
      status: 'queued',
      progress: { stage: 'queued', fraction: 0 },
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      trackId: input.trackId ?? null,
    };
    this.jobs.set(job.id, job);
    this.nextSequence += 1;
    this.sequence.set(job.id, this.nextSequence);
    this.emitUpdate(job);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        (this.sequence.get(b.id) ?? 0) - (this.sequence.get(a.id) ?? 0),
    );
  }

  active(): Job[] {
    return this.list().filter((job) => job.status === 'queued' || job.status === 'running');
  }

  start(jobId: string): Job | undefined {
    return this.patch(jobId, { status: 'running', startedAt: Date.now() });
  }

  /**
   * Record progress.
   *
   * Progress on a finished job is ignored: a late event arriving after
   * cancellation would otherwise resurrect the bar.
   */
  progress(jobId: string, stage: string, fraction: number): Job | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job;
    }
    const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    // Never let the bar move backwards.
    const next = Math.max(job.progress.fraction, clamped);
    return this.patch(jobId, {
      status: 'running',
      startedAt: job.startedAt ?? Date.now(),
      progress: { stage, fraction: next },
    });
  }

  succeed(jobId: string): Job | undefined {
    return this.finish(jobId, 'succeeded', null);
  }

  fail(jobId: string, error: SipraErrorPayload): Job | undefined {
    return this.finish(jobId, 'failed', error);
  }

  cancel(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    return this.finish(jobId, 'cancelled', null);
  }

  private finish(jobId: string, status: JobStatus, error: SipraErrorPayload | null): Job | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const updated = this.patch(jobId, {
      status,
      error,
      finishedAt: Date.now(),
      progress: {
        stage: status,
        fraction: status === 'succeeded' ? 1 : job.progress.fraction,
      },
    });
    this.prune();
    return updated;
  }

  private patch(jobId: string, patch: Partial<Job>): Job | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const updated = { ...job, ...patch, id: job.id };
    this.jobs.set(jobId, updated);
    this.emitUpdate(updated);
    return updated;
  }

  private emitUpdate(job: Job): void {
    this.emit('updated', job);
  }

  /** Trim finished jobs, oldest first, keeping active ones untouched. */
  private prune(): void {
    const finished = this.list().filter(
      (job) => job.status !== 'queued' && job.status !== 'running',
    );
    if (finished.length <= COMPLETED_HISTORY) return;
    for (const job of finished.slice(COMPLETED_HISTORY)) {
      this.jobs.delete(job.id);
      this.sequence.delete(job.id);
    }
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.status !== 'queued' && job.status !== 'running') {
        this.jobs.delete(id);
        this.sequence.delete(id);
      }
    }
  }
}
