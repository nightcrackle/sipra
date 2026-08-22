import { CloseIcon, PlusIcon, SettingsIcon, ShieldIcon } from './Icons';
import { SipraMark } from './SipraMark';
import { useStore } from '../state/store';

interface TitleBarProps {
  onImport: () => void;
}

/**
 * The privacy line lives in the title bar on purpose.
 *
 * "Your audio stays on this computer" is the main reason to use a local
 * separator instead of a web service, and burying it in an About dialog
 * would waste it. It states what is true — separation and analysis are
 * local — without implying the app never touches the network at all.
 */
export function TitleBar({ onImport }: TitleBarProps): JSX.Element {
  const view = useStore((state) => state.view);
  const activeTrack = useStore((state) => state.activeTrack);
  const closeTrack = useStore((state) => state.closeTrack);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const capabilities = useStore((state) => state.capabilities);

  const device = capabilities?.torch?.cuda
    ? capabilities.torch.cudaDevice ?? 'GPU'
    : capabilities?.torch
      ? 'CPU'
      : null;

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <SipraMark size={24} className="titlebar__mark" />
        <span>Sipra</span>
      </div>

      <span className="titlebar__privacy" title="Separation and analysis run on this computer. Nothing is uploaded and there is no account.">
        <ShieldIcon size={13} />
        <strong>Local only</strong>
        <span>· your audio stays on this computer</span>
      </span>

      {device ? (
        <span className="titlebar__privacy" title="The device separation will run on">
          <span>Processing on</span>
          <strong>{device}</strong>
        </span>
      ) : null}

      <div className="titlebar__spacer" />

      {view === 'workspace' && activeTrack ? (
        <button type="button" className="btn btn--ghost" onClick={closeTrack}>
          <CloseIcon size={15} />
          Close track
        </button>
      ) : (
        <button type="button" className="btn btn--primary" onClick={onImport}>
          <PlusIcon size={15} />
          Add music
        </button>
      )}

      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={() => setSettingsOpen(true)}
        aria-label="Settings"
        title="Settings"
      >
        <SettingsIcon size={16} />
      </button>
    </header>
  );
}

export default TitleBar;
