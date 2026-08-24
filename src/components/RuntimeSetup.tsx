import { useState } from 'react';

import type { RuntimeStatus } from '@shared/types';

import { SipraMark } from './SipraMark';

const STAGE_COPY: Record<RuntimeStatus['stage'], string> = {
  idle: '',
  checking: 'Checking what is already installed…',
  'downloading-python': 'Downloading Python…',
  'creating-environment': 'Creating a private Python environment…',
  'installing-packages': 'Downloading the separation engine…',
  verifying: 'Checking the installation…',
  // Done here rather than inside the first separation, where the same wait
  // had no label and read as a stalled job.
  'preparing-model': 'Preparing the separation model…',
  ready: 'Ready.',
  failed: '',
};

interface RuntimeSetupProps {
  status: RuntimeStatus;
  onInstall: () => Promise<void>;
}

/**
 * First-run setup.
 *
 * The download is large and slow, so this screen says so plainly and
 * explains where the bytes go. A progress bar with no explanation is how
 * people end up force-quitting an installer half way through.
 */
export function RuntimeSetup({ status, onInstall }: RuntimeSetupProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const running =
    busy ||
    (status.stage !== 'idle' && status.stage !== 'failed' && status.stage !== 'ready');

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      await onInstall();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup__panel">
        <SipraMark size={62} className="setup__mark" plate />
        <h1 className="setup__title">
          {status.stage === 'failed' ? 'Setup did not finish' : 'One-time setup'}
        </h1>

        {status.stage === 'failed' && status.error ? (
          <div className="setup__error">
            <strong>{status.error.message}</strong>
            {typeof status.error.details?.stderr === 'string' ? (
              <>
                <br />
                <br />
                <code style={{ fontSize: 11.5, opacity: 0.8 }}>
                  {String(status.error.details.stderr).slice(-400)}
                </code>
              </>
            ) : null}
          </div>
        ) : (
          <p className="setup__body">
            Sipra separates music on your own machine, so it needs to install its audio engine
            once before you can use it. This downloads roughly 900&nbsp;MB (or about 2.5&nbsp;GB
            if you have an NVIDIA GPU, which makes separation several times faster).
            <br />
            <br />
            After this, Sipra works offline. The one exception is the first time you use a
            particular separation model, which downloads its weights.
          </p>
        )}

        {running ? (
          <>
            <div className="setup__progress">
              <div className="setup__fill" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
            </div>
            <p className="setup__stage">{status.message || STAGE_COPY[status.stage]}</p>
          </>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => void start()}>
            {status.stage === 'failed' ? 'Try again' : 'Install the audio engine'}
          </button>
        )}

        <div className="setup__facts">
          <p className="setup__fact">
            <strong>Nothing is uploaded.</strong> Your audio is separated and analysed on this
            computer. Sipra has no account system and no server to send it to.
          </p>
          <p className="setup__fact">
            <strong>Where it goes.</strong> The engine is installed inside Sipra&rsquo;s own
            application data folder. It does not change any Python you already have.
          </p>
          <p className="setup__fact">
            <strong>You can stop.</strong> Closing this window cancels the download. Nothing
            outside Sipra&rsquo;s folder is modified.
          </p>
        </div>
      </div>
    </div>
  );
}

export default RuntimeSetup;
