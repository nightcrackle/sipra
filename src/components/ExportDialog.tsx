import { useState } from 'react';

import { formatTime } from '@shared/format';
import { resolveMix } from '@shared/mix';
import { mixExportName } from '@shared/paths';
import { stemLabel } from '@shared/stems';

import { useStore } from '../state/store';
import { Modal } from './Modal';

type Format = 'wav' | 'flac' | 'mp3';
type Depth = 16 | 24 | 32;

const DEPTHS_BY_FORMAT: Record<Format, Depth[]> = {
  wav: [16, 24, 32],
  flac: [16, 24],
  mp3: [16],
};

export function ExportDialog(): JSX.Element | null {
  const open = useStore((state) => state.exportOpen);
  const setOpen = useStore((state) => state.setExportOpen);
  const track = useStore((state) => state.activeTrack);
  const lanes = useStore((state) => state.lanes);
  const loop = useStore((state) => state.loop);
  const masterGainDb = useStore((state) => state.masterGainDb);
  const backingBusDb = useStore((state) => state.backingBusDb);
  const settings = useStore((state) => state.settings);
  const pushNotice = useStore((state) => state.pushNotice);

  const [format, setFormat] = useState<Format>(settings.defaultExportFormat);
  const [depth, setDepth] = useState<Depth>(settings.defaultExportBitDepth);
  const [normalise, setNormalise] = useState(settings.normaliseExports);
  const [rangeOnly, setRangeOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open || !track) return null;

  // The export must sound like the workspace does, so the same resolver
  // decides what is audible here as in the transport.
  const mix = resolveMix(lanes, { masterGainDb: 0, backingBusDb });
  const audible = lanes.filter((lane) => (mix.gains[lane.stemId] ?? 0) > 0);
  const depths = DEPTHS_BY_FORMAT[format];
  const effectiveDepth = depths.includes(depth) ? depth : (depths[0] ?? 16);

  const run = async (): Promise<void> => {
    const suggested = mixExportName(
      track.title,
      audible.map((lane) => lane.stemId),
      `.${format}`,
    );
    const target = await window.sipra.files.pickSaveTarget(suggested, [format]);
    if (!target) return;

    setBusy(true);
    try {
      await window.sipra.tracks.exportMix({
        trackId: track.id,
        outputPath: target,
        lanes: lanes.map((lane) => ({
          stemId: lane.stemId,
          // Fold the backing-bus attenuation into each lane's gain so the
          // rendered file matches what was being auditioned.
          gainDb:
            lane.selected || backingBusDb === null
              ? lane.gainDb
              : lane.gainDb + backingBusDb,
          muted: lane.muted || (!lane.selected && backingBusDb === null),
          solo: lane.solo,
        })),
        format,
        bitDepth: effectiveDepth,
        masterGainDb,
        normalise,
        startSeconds: rangeOnly && loop ? loop.start : null,
        endSeconds: rangeOnly && loop ? loop.end : null,
      });
      setOpen(false);
    } catch (error) {
      pushNotice({ level: 'error', title: 'Export failed', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export mix"
      onClose={() => setOpen(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void run()}
            disabled={busy || audible.length === 0}
          >
            {busy ? 'Rendering…' : 'Choose a location and export'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field__label">What will be exported</span>
        {audible.length === 0 ? (
          <p className="field__hint">
            Every stem is currently muted, so there is nothing to render. Unmute at least one
            lane first.
          </p>
        ) : (
          <p className="field__hint">
            {audible.map((lane) => stemLabel(lane.stemId)).join(', ')} — with the levels, mutes
            and solos exactly as you have them in the workspace.
          </p>
        )}
      </div>

      <div className="field">
        <span className="field__label">Format</span>
        <div className="field__row">
          {(['wav', 'flac', 'mp3'] as Format[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`btn btn--sm${format === candidate ? ' is-active' : ''}`}
              onClick={() => setFormat(candidate)}
            >
              {candidate.toUpperCase()}
            </button>
          ))}
          <div className="grow" />
          {format !== 'mp3' ? (
            <>
              <span className="muted" style={{ fontSize: 12 }}>
                Bit depth
              </span>
              <select
                className="select"
                value={effectiveDepth}
                onChange={(event) => setDepth(Number(event.target.value) as Depth)}
              >
                {depths.map((value) => (
                  <option key={value} value={value}>
                    {value === 32 ? '32-bit float' : `${value}-bit`}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              320 kbps
            </span>
          )}
        </div>
        {format === 'mp3' ? (
          <p className="field__hint">
            MP3 is lossy. For anything you plan to keep working on, WAV or FLAC will not throw
            away detail.
          </p>
        ) : null}
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={normalise}
          onChange={(event) => setNormalise(event.target.checked)}
        />
        <span>
          Normalise the peak to −0.3&nbsp;dBFS.
          <br />
          <span className="muted" style={{ fontSize: 12 }}>
            Only ever turns the mix down, never up, so your balance is preserved. Leave this off
            if you are exporting stems to mix elsewhere.
          </span>
        </span>
      </label>

      {loop ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={rangeOnly}
            onChange={(event) => setRangeOnly(event.target.checked)}
          />
          <span>
            Export only the looped region ({formatTime(loop.start)} – {formatTime(loop.end)})
          </span>
        </label>
      ) : null}
    </Modal>
  );
}

export default ExportDialog;
