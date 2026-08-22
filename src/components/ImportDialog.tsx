import { useEffect, useState } from 'react';

import { formatDuration } from '@shared/format';
import type { YoutubeDiagnosis } from '@shared/ipc';

import { useStore } from '../state/store';
import { LinkIcon, PlusIcon, WarningIcon } from './Icons';
import { Modal } from './Modal';

interface RemoteInfo {
  title: string;
  durationSeconds: number | null;
  uploader: string | null;
  sourceUrl: string;
}

/**
 * Adding music: from disk, or from a link.
 *
 * The link tab is deliberately blunt about what it is. A checkbox is not a
 * licence, and pretending otherwise would be dishonest to the person about
 * to click it.
 */
export function ImportDialog(): JSX.Element | null {
  const open = useStore((state) => state.importOpen);
  const setOpen = useStore((state) => state.setImportOpen);
  const folderId = useStore((state) => state.folderId);
  const pushNotice = useStore((state) => state.pushNotice);

  const [tab, setTab] = useState<'files' | 'link'>('files');
  const [url, setUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloader, setDownloader] = useState<{ available: boolean; allowedHosts: string[] } | null>(
    null,
  );
  const [diagnosis, setDiagnosis] = useState<YoutubeDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void window.sipra.youtube
      .status()
      .then((status) => setDownloader(status))
      .catch(() => setDownloader({ available: false, allowedHosts: [] }));
  }, [open]);

  if (!open) return null;

  const targetFolder = typeof folderId === 'string' ? folderId : null;

  const pickFiles = async (): Promise<void> => {
    const paths = await window.sipra.files.pickAudio();
    if (paths.length === 0) return;
    setOpen(false);
    for (const path of paths) {
      try {
        await window.sipra.tracks.separate({ path, folderId: targetFolder });
      } catch (importError) {
        pushNotice({
          level: 'error',
          title: 'Could not start',
          message: (importError as Error).message,
        });
      }
    }
  };

  /**
   * Run the downloader through its paces and report what it finds.
   *
   * "It timed out" is not something anyone can act on. The difference
   * between "no binary", "binary will not start" and "cannot reach
   * YouTube" needs three different responses, so the app should say which
   * one it is rather than making the user guess.
   */
  const runDiagnosis = async (): Promise<void> => {
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      setDiagnosis(await window.sipra.youtube.diagnose());
    } catch (diagnoseError) {
      setError((diagnoseError as Error).message);
    } finally {
      setDiagnosing(false);
    }
  };

  const lookUp = async (): Promise<void> => {
    setChecking(true);
    setError(null);
    setInfo(null);
    try {
      setInfo(await window.sipra.youtube.metadata(url.trim()));
    } catch (lookupError) {
      setError((lookupError as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const startImport = async (): Promise<void> => {
    try {
      await window.sipra.youtube.import(url.trim(), confirmed, targetFolder);
      setOpen(false);
      setUrl('');
      setConfirmed(false);
      setInfo(null);
    } catch (importError) {
      setError((importError as Error).message);
    }
  };

  return (
    <Modal
      title="Add music"
      onClose={() => setOpen(false)}
      footer={
        tab === 'files' ? (
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void pickFiles()}>
              Choose files
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void lookUp()}
              disabled={!url.trim() || checking}
            >
              {checking ? 'Checking…' : 'Check link'}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void startImport()}
              disabled={!url.trim() || !confirmed || !downloader?.available}
            >
              Download and separate
            </button>
          </>
        )
      }
    >
      <div className="field__row">
        <button
          type="button"
          className={`btn btn--sm${tab === 'files' ? ' is-active' : ''}`}
          onClick={() => setTab('files')}
        >
          <PlusIcon size={13} />
          From this computer
        </button>
        <button
          type="button"
          className={`btn btn--sm${tab === 'link' ? ' is-active' : ''}`}
          onClick={() => setTab('link')}
        >
          <LinkIcon size={13} />
          From a link
        </button>
      </div>

      {tab === 'files' ? (
        <div className="field">
          <p className="field__hint">
            Pick MP3, WAV, FLAC, OGG, M4A or AIFF files — or just drag them anywhere into the
            Sipra window. Each one is copied into Sipra&rsquo;s workspace and separated on this
            computer. Your originals are left untouched.
          </p>
        </div>
      ) : (
        <>
          {!downloader?.available ? (
            <div className="workspace__warning" style={{ margin: 0 }}>
              <WarningIcon size={16} />
              <span>
                The downloader is not available in this build, so links cannot be fetched. You
                can still add files from this computer.
              </span>
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor="import-url">
              Link
            </label>
            <input
              id="import-url"
              className="input"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setInfo(null);
                setError(null);
              }}
              spellCheck={false}
            />
            <p className="field__hint">
              Sipra accepts YouTube links only:{' '}
              {(downloader?.allowedHosts ?? []).join(', ') || 'youtube.com, youtu.be'}.
            </p>
          </div>

          {info ? (
            <div className="field">
              <span className="field__label">Found</span>
              <p className="field__hint">
                <strong style={{ color: 'var(--text-0)' }}>{info.title}</strong>
                {info.uploader ? ` · ${info.uploader}` : ''}
                {info.durationSeconds ? ` · ${formatDuration(info.durationSeconds)}` : ''}
              </p>
            </div>
          ) : null}

          {error ? (
            <div className="workspace__warning" style={{ margin: 0 }}>
              <WarningIcon size={16} />
              <div className="grow">
                <div>{error}</div>
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void runDiagnosis()}
                    disabled={diagnosing}
                  >
                    {diagnosing ? 'Checking the downloader…' : 'Check the downloader'}
                  </button>
                  {/*
                    The log records what the app was doing when this went
                    wrong, with timestamps. It is the only thing that can
                    distinguish a slow step from a stopped one after the
                    fact, so it is offered wherever a failure is shown.
                  */}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void window.sipra.logs.reveal()}
                    title="Open the folder holding Sipra's diagnostic log"
                  >
                    Show the log
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {diagnosis ? (
            <div className="field">
              <span className="field__label">Downloader check</span>
              <p className="field__hint">
                {diagnosis.available
                  ? `Found${diagnosis.version ? ` (${diagnosis.version})` : ''}`
                  : 'Not found in this build'}
                {diagnosis.canReachYoutube === true ? ' · can reach YouTube' : ''}
                {diagnosis.canReachYoutube === false ? ' · cannot reach YouTube' : ''}
                {diagnosis.forcedIpv4 ? ' · forced to IPv4' : ''}
              </p>
              {diagnosis.error ? (
                <p className="field__hint" style={{ color: 'var(--danger)' }}>
                  {diagnosis.error}
                </p>
              ) : null}
              {diagnosis.hints.length > 0 ? (
                <ul className="field__hint" style={{ margin: 0, paddingLeft: 18 }}>
                  {diagnosis.hints.map((hint) => (
                    <li key={hint} style={{ marginBottom: 4 }}>
                      {hint}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I hold the rights to this audio, or it is public domain or openly licensed.
              <br />
              <span className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                Be aware of what this box is and is not. Downloading from YouTube is contrary to
                YouTube&rsquo;s Terms of Service, and ticking this does not change that or grant
                you any right you do not already have. It records that the decision is yours.
              </span>
            </span>
          </label>
        </>
      )}
    </Modal>
  );
}

export default ImportDialog;
