import {
  formatBpm,
  formatChannels,
  formatConfidence,
  formatDb,
  formatDuration,
  formatKey,
  formatLu,
  formatLufs,
  formatSampleRate,
} from '@shared/format';
import type { Track } from '@shared/types';

interface InfoStripProps {
  track: Track;
  onReanalyse: () => void;
  analysing: boolean;
}

interface ItemProps {
  label: string;
  value: string;
  note?: string;
  title?: string;
}

function Item({ label, value, note, title }: ItemProps): JSX.Element {
  return (
    <div className="infostrip__item" title={title}>
      <span className="infostrip__label">{label}</span>
      <span className="infostrip__value">{value}</span>
      {note ? <span className="infostrip__note">{note}</span> : null}
    </div>
  );
}

/**
 * The measured facts about a track.
 *
 * BPM and key carry a confidence word rather than a bare number. These are
 * estimates from signal analysis, and a track where the estimator is
 * guessing should look different from one where it is certain.
 */
export function InfoStrip({ track, onReanalyse, analysing }: InfoStripProps): JSX.Element {
  const analysis = track.analysis;

  return (
    <div className="infostrip">
      <Item label="Length" value={formatDuration(track.durationSeconds)} />
      <Item
        label="Format"
        value={formatSampleRate(track.sampleRate)}
        note={formatChannels(track.channels)}
      />
      <Item
        label="BPM"
        value={formatBpm(analysis?.bpm)}
        note={analysis?.bpm != null ? `${formatConfidence(analysis.bpmConfidence)} confidence` : undefined}
        title="Estimated from onset detection and beat tracking."
      />
      <Item
        label="Key"
        value={formatKey(analysis?.key, analysis?.scale)}
        note={
          analysis?.key
            ? `${analysis.camelot ?? ''} · ${formatConfidence(analysis.keyConfidence)} confidence`.trim()
            : undefined
        }
        title="Estimated by matching the track's pitch-class profile against key templates. Relative major and minor keys share the same notes, so low confidence usually means it could be either."
      />
      <Item
        label="Loudness"
        value={formatLufs(analysis?.integratedLufs)}
        note={analysis?.loudnessRangeLu != null ? `range ${formatLu(analysis.loudnessRangeLu)}` : undefined}
        title="Integrated loudness, gated, to EBU R128."
      />
      <Item
        label="True peak"
        value={formatDb(analysis?.truePeakDb)}
        note={analysis?.samplePeakDb != null ? `sample ${formatDb(analysis.samplePeakDb)}` : undefined}
        title="Inter-sample peak, measured with 4x oversampling."
      />
      <Item
        label="Dynamics"
        value={formatDb(analysis?.crestFactorDb)}
        note="crest factor"
        title="Peak minus RMS. Higher means more dynamic range left in the master."
      />

      <div className="grow" />
      <button
        type="button"
        className="btn btn--sm"
        onClick={onReanalyse}
        disabled={analysing}
        title="Measure tempo, key and loudness again"
      >
        {analysing ? 'Analysing…' : 'Re-analyse'}
      </button>
    </div>
  );
}

export default InfoStrip;
