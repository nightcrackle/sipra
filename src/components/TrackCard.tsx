import {
  formatBpm,
  formatDb,
  formatDuration,
  formatKey,
  formatLufs,
  formatRelativeTime,
} from '@shared/format';
import { sortStems, STEM_BY_ID, type StemId, stemColor, stemLabel } from '@shared/stems';
import type { Track } from '@shared/types';

import { RestoreIcon, TrashIcon } from './Icons';

interface TrackCardProps {
  track: Track;
  selected: boolean;
  dragging: boolean;
  onOpen: (track: Track) => void;
  onSelect: (track: Track, additive: boolean) => void;
  onTrash: (track: Track) => void;
  onRestore: (track: Track) => void;
  onPurge: (track: Track) => void;
  onDragStart: (track: Track, event: React.DragEvent) => void;
  onDragEnd: () => void;
}

interface MetaCellProps {
  label: string;
  value: string;
  weak?: boolean;
  title?: string;
}

function MetaCell({ label, value, weak, title }: MetaCellProps): JSX.Element {
  return (
    <div title={title}>
      <div className="meta-cell__label">{label}</div>
      <div className={`meta-cell__value${weak ? ' is-weak' : ''}`}>{value}</div>
    </div>
  );
}

export function TrackCard({
  track,
  selected,
  dragging,
  onOpen,
  onSelect,
  onTrash,
  onRestore,
  onPurge,
  onDragStart,
  onDragEnd,
}: TrackCardProps): JSX.Element {
  const analysis = track.analysis;
  const inTrash = track.deletedAt !== null;
  const stems = sortStems(track.stems.map((stem) => stem.id)) as StemId[];

  // Confidence is shown as a hint rather than a number: these estimators
  // are good, not authoritative, and a bare "127.4" reads as a fact.
  const bpmTitle =
    analysis?.bpm != null
      ? `Estimated tempo. Confidence: ${Math.round((analysis.bpmConfidence ?? 0) * 100)}%`
      : 'Tempo could not be estimated';
  const keyTitle =
    analysis?.key != null
      ? `Estimated key${analysis.camelot ? ` · Camelot ${analysis.camelot}` : ''}. Confidence: ${Math.round(
          (analysis.keyConfidence ?? 0) * 100,
        )}%`
      : 'Key could not be estimated';

  return (
    <article
      className={`card${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
      draggable={!inTrash}
      onDragStart={(event) => onDragStart(track, event)}
      onDragEnd={onDragEnd}
      onClick={(event) => onSelect(track, event.ctrlKey || event.metaKey)}
      onDoubleClick={() => !inTrash && onOpen(track)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !inTrash) onOpen(track);
      }}
      aria-label={track.title}
    >
      <div className="card__head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="card__title" title={track.title}>
            {track.title}
          </div>
          <div className="card__sub">
            {inTrash
              ? `Deleted ${formatRelativeTime(track.deletedAt ?? 0)}`
              : `${formatRelativeTime(track.updatedAt)} · ${track.modelId}`}
          </div>
        </div>

        {inTrash ? (
          <div className="row">
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={(event) => {
                event.stopPropagation();
                onRestore(track);
              }}
              title="Restore"
              aria-label={`Restore ${track.title}`}
            >
              <RestoreIcon size={14} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm btn--danger"
              onClick={(event) => {
                event.stopPropagation();
                onPurge(track);
              }}
              title="Delete permanently"
              aria-label={`Delete ${track.title} permanently`}
            >
              <TrashIcon size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={(event) => {
              event.stopPropagation();
              onTrash(track);
            }}
            title="Move to trash"
            aria-label={`Move ${track.title} to trash`}
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>

      <div className="card__stems">
        {stems.map((stemId) => (
          <span
            key={stemId}
            className="stem-chip"
            title={STEM_BY_ID[stemId]?.note || stemLabel(stemId)}
          >
            <span className="stem-chip__dot" style={{ background: stemColor(stemId) }} />
            {stemLabel(stemId)}
          </span>
        ))}
      </div>

      <div className="card__meta">
        <MetaCell label="Length" value={formatDuration(track.durationSeconds)} />
        <MetaCell
          label="BPM"
          value={formatBpm(analysis?.bpm)}
          weak={(analysis?.bpmConfidence ?? 0) < 0.4}
          title={bpmTitle}
        />
        <MetaCell
          label="Key"
          value={formatKey(analysis?.key, analysis?.scale)}
          weak={(analysis?.keyConfidence ?? 0) < 0.4}
          title={keyTitle}
        />
        <MetaCell
          label="Loudness"
          value={formatLufs(analysis?.integratedLufs)}
          title={`Integrated loudness (EBU R128). Peak ${formatDb(analysis?.truePeakDb)} true peak.`}
        />
      </div>
    </article>
  );
}

export default TrackCard;
