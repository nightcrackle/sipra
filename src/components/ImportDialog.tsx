import { useEffect, useState } from 'react';

import { formatDuration } from '@shared/format';

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
              <span>{error}</span>
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
