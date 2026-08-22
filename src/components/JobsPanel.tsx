import { formatPercent } from '@shared/format';
import type { Job } from '@shared/types';

import { CloseIcon } from './Icons';
import { useStore } from '../state/store';

const STAGE_LABELS: Record<string, string> = {
  queued: 'Waiting',
  decode: 'Reading the file',
  download: 'Downloading',
  separate: 'Separating stems',
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
  if (visible.length === 0) return null;

  return (
    <section className="jobs" aria-label="Background jobs">
      {visible.map((job) => {
        const running = job.status === 'queued' || job.status === 'running';
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
                  <div
                    className={`job__fill${job.status === 'succeeded' ? ' is-done' : ''}`}
                    style={{ width: `${Math.round(job.progress.fraction * 100)}%` }}
                  />
                </div>
                <span className="job__pct tabular">{formatPercent(job.progress.fraction)}</span>
              </>
            )}

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
