import { useEffect, useState } from 'react';

import { formatElapsed, formatPercent } from '@shared/format';
import type { Job } from '@shared/types';

import { CloseIcon } from './Icons';
import { useStore } from '../state/store';

const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting',
  starting: 'Starting',
  prepare: 'Checking the downloader',
  metadata: 'Reading the link',
  decode: 'Reading the file',
  download: 'Downloading',
  model: 'Preparing the model',
  separate: 'Separating stems',
  collect: 'Collecting the stems',
  write: 'Writing stems',
  peaks: 'Drawing waveforms',
  analyse: 'Measuring tempo, key and loudness',
  export: 'Rendering the mix',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function stageLabel(job: Job): string {
  return STAGE_LABELS[job.progress.stage] ?? job.progress.stage;
}

/**
 * How long a job runs before the log is offered alongside it.
 *
 * Separating a full song on a CPU legitimately takes many minutes, so this
 * is not a warning — it is the point at which someone might reasonably
 * want to see what the app is actually doing.
 */
const SLOW_JOB_MS = 120_000;

/**
 * Stages whose duration genuinely cannot be predicted.
 *
 * These get a moving bar rather than a still one. Preparing a model may be
 * instant or may be a several-hundred-megabyte download followed by a cold
 * compute device; checking a downloader and reading a link depend on a
 * remote host. A frozen number through any of them reads as a fault, and
 * inventing a fraction to avoid that would be worse than admitting the
 * duration is unknown.
 */
const INDETERMINATE_STAGES = new Set(['model', 'prepare', 'metadata', 'starting']);

/**
 * A strip of running jobs.
 *
 * Finished jobs disappear from view unless they failed — a failure the
 * user never sees is a failure they will blame on the app being broken.
 */
export function JobsPanel(): JSX.Element | null {
  const jobs = useStore((state) => state.jobs);
  const cancel = async (jobId: string): Promise<void> => {
    await window.sipra.jobs.cancel(jobId);
  };

  const visible = jobs.filter(
    (job) => job.status === 'queued' || job.status === 'running' || job.status === 'failed',
  );
  const anyRunning = visible.some((job) => job.status === 'running');

  // A clock, only while something is running. The elapsed time has to tick
  // on its own: a job that has genuinely stopped sends no more updates, so
  // a counter driven by job events would freeze at exactly the moment its
  // reading became interesting.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  if (visible.length === 0) return null;

  return (
    <section className="jobs" aria-label="Background jobs">
      {visible.map((job) => {
        const running = job.status === 'queued' || job.status === 'running';
        const indeterminate =
          job.status === 'running' &&
          (job.progress.fraction <= 0 || INDETERMINATE_STAGES.has(job.progress.stage));
        // Offered when there is something to explain: a failure, or a job
        // that has been going long enough for the user to start wondering.
        const showLogButton =
          job.status === 'failed' ||
          (job.status === 'running' && now - (job.startedAt ?? job.createdAt) > SLOW_JOB_MS);
        return (
          <div className="job" key={job.id}>
            <span className="job__label" title={job.label}>
              {job.label}
            </span>

            {job.status === 'failed' ? (
              <span className="job__error" title={job.error?.message}>
                {job.error?.message ?? 'Something went wrong.'}
              </span>
            ) : (
              <>
                <span className="muted" style={{ minWidth: 178, fontSize: 12 }}>
                  {stageLabel(job)}
                </span>
                <div className="job__bar">
                  {/*
                    A running job that has not reported a number yet gets a
                    moving bar rather than an empty one. Some stages are
                    genuinely long before they can report anything, and a
                    flat 0% there is indistinguishable from stuck.
                  */}
                  <div
                    className={`job__fill${job.status === 'succeeded' ? ' is-done' : ''}${
                      indeterminate ? ' is-indeterminate' : ''
                    }`}
                    style={
                      indeterminate
                        ? undefined
                        : { width: `${Math.round(job.progress.fraction * 100)}%` }
                    }
                  />
                </div>
                <span className="job__pct tabular">
                  {indeterminate ? '—' : formatPercent(job.progress.fraction)}
                </span>
                {job.status === 'running' ? (
                  <span className="job__elapsed tabular muted" title="Time spent on this job">
                    {formatElapsed(now - (job.startedAt ?? job.createdAt))}
                  </span>
                ) : null}
              </>
            )}

            {showLogButton ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void window.sipra.logs.reveal()}
                title="Open the folder holding Sipra's diagnostic log"
              >
                Log
              </button>
            ) : null}

            {running ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void cancel(job.id)}
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                onClick={() => useStore.setState({ jobs: jobs.filter((j) => j.id !== job.id) })}
                aria-label="Dismiss"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export default JobsPanel;
