/**
 * Library queries and mutations, as pure functions over `LibraryState`.
 *
 * The main process owns persistence; everything about *what the library
 * contains after an action* lives here so it can be tested without a
 * filesystem, and so the renderer can preview a change optimistically
 * using the exact same logic.
 */

import type { Folder, LibraryQuery, LibraryState, Track, TrackSortKey } from './types';
import { LIBRARY_SCHEMA_VERSION } from './types';
import type { StemId } from './stems';

export const TRASH_RETENTION_DAYS = 30;

export function emptyLibrary(): LibraryState {
  return { schemaVersion: LIBRARY_SCHEMA_VERSION, tracks: [], folders: [] };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Split a query into tokens, keeping "quoted phrases" together.
 */
export function tokenizeQuery(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = (match[1] ?? match[2] ?? '').trim().toLowerCase();
    if (token) tokens.push(token);
  }
  return tokens;
}

function haystackFor(track: Track): string {
  return [
    track.title,
    track.artist ?? '',
    track.originalFileName,
    track.notes,
    track.tags.join(' '),
    track.analysis?.keyLabel ?? '',
    track.analysis?.camelot ?? '',
    track.analysis?.bpm != null ? String(Math.round(track.analysis.bpm)) : '',
    track.modelId,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Every token must appear somewhere in the track, so adding words narrows
 * the result set — the behaviour people expect from a search box.
 */
export function matchesQuery(track: Track, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = haystackFor(track);
  return tokens.every((token) => haystack.includes(token));
}

export function searchTracks(tracks: readonly Track[], text: string): Track[] {
  const tokens = tokenizeQuery(text ?? '');
  if (tokens.length === 0) return [...tracks];
  return tracks.filter((track) => matchesQuery(track, tokens));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortValue(track: Track, key: TrackSortKey): number | string {
  switch (key) {
    case 'title':
      return track.title.toLowerCase();
    case 'duration':
      return track.durationSeconds;
    case 'bpm':
      return track.analysis?.bpm ?? -1;
    case 'loudness':
      return track.analysis?.integratedLufs ?? -Infinity;
    case 'recent':
    default:
      return track.updatedAt;
  }
}

export function sortTracks(
  tracks: readonly Track[],
  key: TrackSortKey = 'recent',
  descending = true,
): Track[] {
  const direction = descending ? -1 : 1;
  return [...tracks].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * direction;
    }
    if (left === right) return a.title.localeCompare(b.title);
    return (left < right ? -1 : 1) * direction;
  });
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

export function queryTracks(state: LibraryState, query: LibraryQuery = {}): Track[] {
  const scope = query.scope ?? 'live';
  let result = state.tracks.filter((track) =>
    scope === 'trash' ? track.deletedAt !== null : track.deletedAt === null,
  );

  // `undefined` means "any folder"; `null` means "the unfiled root".
  if (query.folderId !== undefined) {
    result = result.filter((track) => track.folderId === query.folderId);
  }

  if (query.stems && query.stems.length > 0) {
    const wanted = new Set<StemId>(query.stems);
    result = result.filter((track) => track.stems.some((stem) => wanted.has(stem.id)));
  }

  if (query.text) {
    result = searchTracks(result, query.text);
  }

  return sortTracks(result, query.sort ?? 'recent', query.descending ?? true);
}

export function findTrack(state: LibraryState, trackId: string): Track | undefined {
  return state.tracks.find((track) => track.id === trackId);
}

export function countByFolder(state: LibraryState): Record<string, number> {
  const counts: Record<string, number> = { __unfiled__: 0 };
  for (const folder of state.folders) counts[folder.id] = 0;
  for (const track of state.tracks) {
    if (track.deletedAt !== null) continue;
    const key = track.folderId ?? '__unfiled__';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function trashCount(state: LibraryState): number {
  return state.tracks.filter((track) => track.deletedAt !== null).length;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function withTracks(state: LibraryState, tracks: Track[]): LibraryState {
  return { ...state, tracks };
}

export function upsertTrack(state: LibraryState, track: Track): LibraryState {
  const index = state.tracks.findIndex((existing) => existing.id === track.id);
  if (index === -1) return withTracks(state, [...state.tracks, track]);
  const next = [...state.tracks];
  next[index] = track;
  return withTracks(state, next);
}

export function updateTrack(
  state: LibraryState,
  trackId: string,
  patch: Partial<Track>,
  now: number = Date.now(),
): LibraryState {
  return withTracks(
    state,
    state.tracks.map((track) =>
      track.id === trackId ? { ...track, ...patch, id: track.id, updatedAt: now } : track,
    ),
  );
}

/**
 * Move tracks into a folder (or to the unfiled root with `null`).
 *
 * A move to a folder that does not exist is ignored rather than silently
 * orphaning the tracks — a drag onto a folder deleted in another window
 * should do nothing, not lose the track.
 */
export function moveTracks(
  state: LibraryState,
  trackIds: readonly string[],
  folderId: string | null,
  now: number = Date.now(),
): LibraryState {
  if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) {
    return state;
  }
  const wanted = new Set(trackIds);
  return withTracks(
    state,
    state.tracks.map((track) =>
      wanted.has(track.id) ? { ...track, folderId, updatedAt: now } : track,
    ),
  );
}

/** Soft-delete: the files stay on disk until the trash is emptied. */
export function trashTracks(
  state: LibraryState,
  trackIds: readonly string[],
  now: number = Date.now(),
): LibraryState {
  const wanted = new Set(trackIds);
  return withTracks(
    state,
    state.tracks.map((track) =>
      wanted.has(track.id) && track.deletedAt === null
        ? { ...track, deletedAt: now, updatedAt: now }
        : track,
    ),
  );
}

export function restoreTracks(
  state: LibraryState,
  trackIds: readonly string[],
  now: number = Date.now(),
): LibraryState {
  const wanted = new Set(trackIds);
  return withTracks(
    state,
    state.tracks.map((track) =>
      wanted.has(track.id) && track.deletedAt !== null
        ? { ...track, deletedAt: null, updatedAt: now }
        : track,
    ),
  );
}

/**
 * Remove tracks from the index for good.
 *
 * Only trashed tracks can be purged, so a mis-sent id cannot destroy a
 * live track. The caller deletes the files afterwards.
 */
export function purgeTracks(state: LibraryState, trackIds: readonly string[]): LibraryState {
  const wanted = new Set(trackIds);
  return withTracks(
    state,
    state.tracks.filter((track) => !(wanted.has(track.id) && track.deletedAt !== null)),
  );
}

export function emptyTrash(state: LibraryState): LibraryState {
  return withTracks(
    state,
    state.tracks.filter((track) => track.deletedAt === null),
  );
}

/** Trashed tracks older than the retention window, for automatic cleanup. */
export function expiredTrash(
  state: LibraryState,
  now: number = Date.now(),
  retentionDays: number = TRASH_RETENTION_DAYS,
): Track[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return state.tracks.filter((track) => track.deletedAt !== null && track.deletedAt < cutoff);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function createFolder(
  state: LibraryState,
  name: string,
  id: string,
  now: number = Date.now(),
): LibraryState {
  const trimmed = name.trim() || 'New folder';
  const order = state.folders.reduce((max, folder) => Math.max(max, folder.order), -1) + 1;
  const folder: Folder = { id, name: trimmed, createdAt: now, order };
  return { ...state, folders: [...state.folders, folder] };
}

export function renameFolder(state: LibraryState, folderId: string, name: string): LibraryState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: trimmed } : folder,
    ),
  };
}

/**
 * Delete a folder and unfile its tracks.
 *
 * Deleting a folder must never delete music. Its tracks move to the
 * unfiled root, where they are still findable.
 */
export function deleteFolder(
  state: LibraryState,
  folderId: string,
  now: number = Date.now(),
): LibraryState {
  return {
    ...state,
    folders: state.folders.filter((folder) => folder.id !== folderId),
    tracks: state.tracks.map((track) =>
      track.folderId === folderId ? { ...track, folderId: null, updatedAt: now } : track,
    ),
  };
}

/** Reorder folders by moving one to a new index, renumbering the rest. */
export function reorderFolders(
  state: LibraryState,
  folderId: string,
  targetIndex: number,
): LibraryState {
  const ordered = [...state.folders].sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((folder) => folder.id === folderId);
  if (from === -1) return state;

  const [moved] = ordered.splice(from, 1);
  if (!moved) return state;
  const to = Math.min(ordered.length, Math.max(0, targetIndex));
  ordered.splice(to, 0, moved);

  return {
    ...state,
    folders: ordered.map((folder, index) => ({ ...folder, order: index })),
  };
}

export function sortedFolders(state: LibraryState): Folder[] {
  return [...state.folders].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a parsed JSON blob into a valid `LibraryState`.
 *
 * A library file that has been hand-edited, half-written by a power cut,
 * or produced by a newer build must never crash the app on launch. Every
 * unusable entry is dropped and the rest is kept.
 */
export function normaliseLibrary(raw: unknown): LibraryState {
  const base = emptyLibrary();
  if (!raw || typeof raw !== 'object') return base;
  const candidate = raw as Partial<LibraryState>;

  const folders: Folder[] = Array.isArray(candidate.folders)
    ? candidate.folders
        .filter((folder): folder is Folder => !!folder && typeof folder.id === 'string')
        .map((folder, index) => ({
          id: folder.id,
          name: typeof folder.name === 'string' && folder.name ? folder.name : 'Folder',
          createdAt: Number.isFinite(folder.createdAt) ? folder.createdAt : Date.now(),
          order: Number.isFinite(folder.order) ? folder.order : index,
        }))
    : [];

  const folderIds = new Set(folders.map((folder) => folder.id));

  const tracks: Track[] = Array.isArray(candidate.tracks)
    ? candidate.tracks
        .filter(
          (track): track is Track =>
            !!track && typeof track.id === 'string' && typeof track.trackDir === 'string',
        )
        .map((track) => ({
          ...track,
          title: typeof track.title === 'string' && track.title ? track.title : 'Untitled',
          artist: typeof track.artist === 'string' ? track.artist : null,
          tags: Array.isArray(track.tags) ? track.tags.filter((t) => typeof t === 'string') : [],
          notes: typeof track.notes === 'string' ? track.notes : '',
          warnings: Array.isArray(track.warnings)
            ? track.warnings.filter((w) => typeof w === 'string')
            : [],
          stems: Array.isArray(track.stems) ? track.stems : [],
          // A track pointing at a folder that no longer exists becomes
          // unfiled rather than invisible.
          folderId: track.folderId && folderIds.has(track.folderId) ? track.folderId : null,
          deletedAt: Number.isFinite(track.deletedAt) ? track.deletedAt : null,
          createdAt: Number.isFinite(track.createdAt) ? track.createdAt : Date.now(),
          updatedAt: Number.isFinite(track.updatedAt) ? track.updatedAt : Date.now(),
          durationSeconds: Number.isFinite(track.durationSeconds) ? track.durationSeconds : 0,
          analysis: track.analysis ?? null,
        }))
    : [];

  return { schemaVersion: LIBRARY_SCHEMA_VERSION, folders, tracks };
}
