import { useEffect, useState } from 'react';

import type { AppInfo } from '@shared/ipc';
import type { Settings } from '@shared/types';

import { useStore } from '../state/store';
import { Modal } from './Modal';
import { WarningIcon } from './Icons';

export function SettingsDialog(): JSX.Element | null {
  const open = useStore((state) => state.settingsOpen);
  const setOpen = useStore((state) => state.setSettingsOpen);
  const settings = useStore((state) => state.settings);
  const setSettings = useStore((state) => state.setSettings);
  const capabilities = useStore((state) => state.capabilities);
  const runtime = useStore((state) => state.runtime);

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.sipra.appInfo().then(setAppInfo).catch(() => undefined);
  }, [open]);

  if (!open) return null;

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettings(await window.sipra.settings.set(patch));
  };

  const engine = capabilities?.engines.find((candidate) => candidate.id === settings.engineId);
  const models = engine?.models ?? [];
  const model = models.find((candidate) => candidate.id === settings.modelId);
  const devices = engine?.devices ?? [];

  return (
    <Modal
      title="Settings"
      wide
      onClose={() => setOpen(false)}
      footer={
        <button type="button" className="btn btn--primary" onClick={() => setOpen(false)}>
          Done
        </button>
      }
    >
      <div className="field">
        <span className="field__label">Separation model</span>
        <select
          className="select"
          value={settings.modelId}
          onChange={(event) => void update({ modelId: event.target.value })}
        >
          {models.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        {model ? <p className="field__hint">{model.description}</p> : null}
        {model?.experimental ? (
          <div className="workspace__warning" style={{ margin: '4px 0 0' }}>
            <WarningIcon size={15} />
            <span>
              This model adds guitar and piano, and those two sources are the weakest thing
              Demucs does. Guitar is usable; piano bleeds badly. If you only need vocals, drums
              and bass, the 4-stem model is cleaner and faster.
            </span>
          </div>
        ) : null}
      </div>

      <div className="field">
        <span className="field__label">Stems to produce</span>
        <div className="field__row">
          <button
            type="button"
            className={`btn btn--sm${settings.stemPreset === 'four' ? ' is-active' : ''}`}
            onClick={() => void update({ stemPreset: 'four' })}
          >
            4 — vocals, drums, bass, other
          </button>
          <button
            type="button"
            className={`btn btn--sm${settings.stemPreset === 'six' ? ' is-active' : ''}`}
            onClick={() => void update({ stemPreset: 'six' })}
          >
            6 — adds guitar and piano
          </button>
        </div>
        <p className="field__hint">
          Six stems only works with a model that supports them; with a 4-stem model this setting
          is ignored.
        </p>
      </div>

      <div className="field">
        <span className="field__label">Processing device</span>
        <select
          className="select"
          value={settings.device ?? ''}
          onChange={(event) => void update({ device: event.target.value || null })}
        >
          <option value="">Automatic ({devices[0] ?? 'cpu'})</option>
          {devices.map((device) => (
            <option key={device} value={device}>
              {device.toUpperCase()}
            </option>
          ))}
        </select>
        {capabilities?.torch?.cuda ? (
          <p className="field__hint">
            GPU acceleration is available ({capabilities.torch.cudaDevice}). Separation on a GPU
            is typically five to twenty times faster than on CPU.
          </p>
        ) : (
          <p className="field__hint">
            No CUDA GPU was detected, so separation runs on the CPU. Expect roughly one to three
            minutes per song depending on your processor.
          </p>
        )}
      </div>

      <div className="field">
        <span className="field__label">Defaults for export</span>
        <div className="field__row">
          <select
            className="select"
            value={settings.defaultExportFormat}
            onChange={(event) =>
              void update({ defaultExportFormat: event.target.value as Settings['defaultExportFormat'] })
            }
          >
            <option value="wav">WAV</option>
            <option value="flac">FLAC</option>
            <option value="mp3">MP3</option>
          </select>
          <select
            className="select"
            value={settings.defaultExportBitDepth}
            onChange={(event) =>
              void update({
                defaultExportBitDepth: Number(event.target.value) as Settings['defaultExportBitDepth'],
              })
            }
          >
            <option value={16}>16-bit</option>
            <option value={24}>24-bit</option>
            <option value={32}>32-bit float</option>
          </select>
        </div>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.autoAnalyse}
          onChange={(event) => void update({ autoAnalyse: event.target.checked })}
        />
        <span>
          Measure BPM, key and loudness after separating
          <br />
          <span className="muted" style={{ fontSize: 12 }}>
            Adds a few seconds per track. You can always run it later from the workspace.
          </span>
        </span>
      </label>

      <div className="field">
        <span className="field__label">Level meters</span>
        <div className="field__row">
          <button
            type="button"
            className={`btn btn--sm${settings.meterBallistics === 'peak' ? ' is-active' : ''}`}
            onClick={() => void update({ meterBallistics: 'peak' })}
          >
            Peak
          </button>
          <button
            type="button"
            className={`btn btn--sm${settings.meterBallistics === 'rms' ? ' is-active' : ''}`}
            onClick={() => void update({ meterBallistics: 'rms' })}
          >
            RMS
          </button>
        </div>
      </div>

      <div className="field">
        <span className="field__label">About</span>
        <p className="field__hint">
          Sipra {appInfo?.version ?? ''} · Electron {appInfo?.electron ?? ''} · Python{' '}
          {capabilities?.python ?? '—'}
          <br />
          Audio engine: {capabilities?.version ?? '—'}
          {capabilities?.torch ? ` · PyTorch ${capabilities.torch.version}` : ''}
          <br />
          Workspace: <code style={{ fontSize: 11.5 }}>{appInfo?.workspaceDir ?? '—'}</code>
          {runtime?.pythonPath ? (
            <>
              <br />
              Runtime: <code style={{ fontSize: 11.5 }}>{runtime.pythonPath}</code>
            </>
          ) : null}
        </p>
        <p className="field__hint">
          Separation and analysis run entirely on this computer. Sipra has no account system and
          uploads nothing. It reaches the network only to install its audio engine, to download
          a separation model the first time you use it, and — if you use it — to fetch a link
          you paste in.
        </p>
      </div>
    </Modal>
  );
}

export default SettingsDialog;
