import { useMemo, useState } from 'react';

import { queryTracks } from '@shared/library';
import type { Track, TrackSortKey } from '@shared/types';

import { PlusIcon, TrashIcon } from './Icons';
import { TrackCard } from './TrackCard';
import { useStore } from '../state/store';

const SORT_OPTIONS: Array<{ value: TrackSortKey; label: string }> = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'title', label: 'Title' },
  { value: 'duration', label: 'Length' },
  { value: 'bpm', label: 'BPM' },
  { value: 'loudness', label: 'Loudness' },
];

interface LibraryViewProps {
  onImport: () => void;
}

export function LibraryView({ onImport }: LibraryViewProps): JSX.Element {
  const library = useStore((state) => state.library);
  const searchText = useStore((state) => state.searchText);
  const folderId = useStore((state) => state.folderId);
  const scope = useStore((state) => state.scope);
  const sortKey = useStore((state) => state.sortKey);
  const sortDescending = useStore((state) => state.sortDescending);
  const selectedTrackIds = useStore((state) => state.selectedTrackIds);
  const setSort = useStore((state) => state.setSort);
  const toggleTrackSelection = useStore((state) => state.toggleTrackSelection);
  const openTrack = useStore((state) => state.openTrack);
  const pushNotice = useStore((state) => state.pushNotice);

  const [draggingId, setDraggingId] = useState<string | null>(null);

  const tracks = useMemo(
    () =>
      queryTracks(library, {
        text: searchText,
        // `undefined` means "every folder"; `null` means "unfiled".
        ...(folderId === undefined ? {} : { folderId }),
        scope,
        sort: sortKey,
        descending: sortDescending,
      }),
    [library, searchText, folderId, scope, sortKey, sortDescending],
  );

  const heading = (): string => {
    if (scope === 'trash') return 'Trash';
    if (folderId === null) return 'Unfiled';
    if (folderId) {
      return library.folders.find((folder) => folder.id === folderId)?.name ?? 'Folder';
    }
    return 'All tracks';
  };

  const startDrag = (track: Track, event: React.DragEvent): void => {
    setDraggingId(track.id);
    // Dragging an unselected card drags just that card; dragging one of a
    // multi-selection drags the whole selection.
    const ids = selectedTrackIds.includes(track.id) ? selectedTrackIds : [track.id];
    event.dataTransfer.setData('application/x-sipra-tracks', JSON.stringify(ids));
    event.dataTransfer.setData('text/plain', track.title);
    event.dataTransfer.effectAllowed = 'move';
  };

  const trash = async (track: Track): Promise<void> => {
    const ids = selectedTrackIds.includes(track.id) ? selectedTrackIds : [track.id];
    await window.sipra.library.trashTracks(ids);
    pushNotice({
      level: 'info',
      title: ids.length > 1 ? `${ids.length} tracks moved to trash` : 'Moved to trash',
      message: 'Files are kept until you empty the trash. Deleted items are cleared after 30 days.',
    });
  };

  const restore = async (track: Track): Promise<void> => {
    await window.sipra.library.restoreTracks([track.id]);
  };

  const purge = async (track: Track): Promise<void> => {
    await window.sipra.library.purgeTracks([track.id]);
    pushNotice({
      level: 'info',
      title: 'Deleted permanently',
      message: `"${track.title}" and its stems have been removed from disk.`,
    });
  };

  const emptyTrash = async (): Promise<void> => {
    await window.sipra.library.emptyTrash();
  };

  return (
    <section className="library">
      <div className="library__toolbar">
        <h2 className="library__title">{heading()}</h2>
        <span className="library__count">
          {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
        </span>
        <div className="grow" />

        {scope === 'trash' ? (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void emptyTrash()}
            disabled={tracks.length === 0}
          >
            <TrashIcon size={14} />
            Empty trash
          </button>
        ) : (
          <>
            <label className="sr-only" htmlFor="library-sort">
              Sort by
            </label>
            <select
              id="library-sort"
              className="select"
              value={sortKey}
              onChange={(event) => setSort(event.target.value as TrackSortKey, true)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setSort(sortKey, !sortDescending)}
              title={sortDescending ? 'Descending' : 'Ascending'}
            >
              {sortDescending ? '↓' : '↑'}
            </button>
          </>
        )}
      </div>

      <div className="library__grid">
        {tracks.length === 0 ? (
          <div className="empty">
            {scope === 'trash' ? (
              <>
                <h3 className="empty__title">Trash is empty</h3>
                <p className="empty__body">
                  Tracks you delete land here first. Their files stay on disk until you empty the
                  trash, and anything left for 30 days is cleared automatically.
                </p>
              </>
            ) : searchText ? (
              <>
                <h3 className="empty__title">Nothing matched &ldquo;{searchText}&rdquo;</h3>
                <p className="empty__body">
                  Search looks at titles, file names, notes, tags, key and BPM. Try a shorter
                  term, or clear the search to see everything.
                </p>
              </>
            ) : (
              <>
                <h3 className="empty__title">No tracks here yet</h3>
                <p className="empty__body">
                  Drop an MP3, WAV or FLAC anywhere in this window and Sipra will split it into
                  stems on this computer. Nothing is uploaded and no account is needed.
                </p>
                <button type="button" className="btn btn--primary" onClick={onImport}>
                  <PlusIcon size={15} />
                  Add music
                </button>
              </>
            )}
          </div>
        ) : (
          tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              selected={selectedTrackIds.includes(track.id)}
              dragging={draggingId === track.id}
              onOpen={openTrack}
              onSelect={(candidate, additive) => toggleTrackSelection(candidate.id, additive)}
              onTrash={(candidate) => void trash(candidate)}
              onRestore={(candidate) => void restore(candidate)}
              onPurge={(candidate) => void purge(candidate)}
              onDragStart={startDrag}
              onDragEnd={() => setDraggingId(null)}
            />
          ))
        )}
      </div>
    </section>
  );
}

export default LibraryView;
