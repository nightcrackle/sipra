import { describe, expect, it } from 'vitest';

import {
  countByFolder,
  createFolder,
  deleteFolder,
  emptyLibrary,
  emptyTrash,
  expiredTrash,
  findTrack,
  matchesQuery,
  moveTracks,
  normaliseLibrary,
  purgeTracks,
  queryTracks,
  renameFolder,
  reorderFolders,
  restoreTracks,
  searchTracks,
  sortedFolders,
  sortTracks,
  tokenizeQuery,
  TRASH_RETENTION_DAYS,
  trashCount,
  trashTracks,
  updateTrack,
  upsertTrack,
} from '@shared/library';
import type { LibraryState, Track } from '@shared/types';

function makeTrack(overrides: Partial<Track> = {}): Track {
  const base: Track = {
    id: 'track-1',
    title: 'Midnight Drive',
    artist: 'The Wires',
    createdAt: 1000,
    updatedAt: 1000,
    folderId: null,
    trackDir: '/ws/tracks/midnight',
    sourcePath: '/ws/tracks/midnight/source.wav',
    sourcePeaksPath: '/ws/tracks/midnight/peaks/source.speaks',
    originalFileName: 'midnight-drive.mp3',
    sourceUrl: null,
    fingerprint: 'abc',
    durationSeconds: 210,
    sampleRate: 44100,
    channels: 2,
    engineId: 'demucs',
    modelId: 'htdemucs',
    device: 'CPU',
    stems: [
      {
        id: 'vocals',
        audioPath: '/ws/tracks/midnight/stems/vocals.wav',
        peaksPath: '/ws/tracks/midnight/peaks/vocals.speaks',
        samplePeakDb: -1,
        rmsDb: -14,
      },
    ],
    analysis: {
      durationSeconds: 210,
      sampleRate: 44100,
      channels: 2,
      bpm: 128,
      bpmConfidence: 0.9,
      key: 'A',
      scale: 'minor',
      keyLabel: 'A minor',
      keyConfidence: 0.8,
      camelot: '8A',
      integratedLufs: -9.4,
      loudnessRangeLu: 5,
      samplePeakDb: -0.4,
      truePeakDb: -0.1,
      rmsDb: -12,
      crestFactorDb: 11.6,
    },
    tags: ['demo'],
    notes: '',
    deletedAt: null,
    warnings: [],
  };
  return { ...base, ...overrides };
}

function makeLibrary(tracks: Track[], folders: LibraryState['folders'] = []): LibraryState {
  return { ...emptyLibrary(), tracks, folders };
}

describe('tokenizeQuery', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenizeQuery('Midnight DRIVE')).toEqual(['midnight', 'drive']);
  });

  it('keeps a quoted phrase together', () => {
    expect(tokenizeQuery('"midnight drive" wires')).toEqual(['midnight drive', 'wires']);
  });

  it('ignores empty input', () => {
    expect(tokenizeQuery('   ')).toEqual([]);
    expect(tokenizeQuery('')).toEqual([]);
  });
});

describe('matchesQuery', () => {
  const track = makeTrack();

  it('matches on title, artist and file name', () => {
    expect(matchesQuery(track, ['midnight'])).toBe(true);
    expect(matchesQuery(track, ['wires'])).toBe(true);
    expect(matchesQuery(track, ['mp3'])).toBe(true);
  });

  it('matches on key, camelot and BPM', () => {
    expect(matchesQuery(track, ['a minor'])).toBe(true);
    expect(matchesQuery(track, ['8a'])).toBe(true);
    expect(matchesQuery(track, ['128'])).toBe(true);
  });

  it('matches on tags', () => {
    expect(matchesQuery(track, ['demo'])).toBe(true);
  });

  it('requires every token to match, so more words narrow the results', () => {
    expect(matchesQuery(track, ['midnight', 'wires'])).toBe(true);
    expect(matchesQuery(track, ['midnight', 'nonsense'])).toBe(false);
  });

  it('matches everything for an empty query', () => {
    expect(matchesQuery(track, [])).toBe(true);
  });
});

describe('searchTracks', () => {
  const tracks = [makeTrack(), makeTrack({ id: 't2', title: 'Sunrise', artist: null })];

  it('filters by text', () => {
    expect(searchTracks(tracks, 'sunrise').map((t) => t.id)).toEqual(['t2']);
  });

  it('returns everything for an empty query', () => {
    expect(searchTracks(tracks, '')).toHaveLength(2);
  });

  it('handles a track with no artist', () => {
    expect(() => searchTracks(tracks, 'wires')).not.toThrow();
  });
});

describe('sortTracks', () => {
  const tracks = [
    makeTrack({ id: 'a', title: 'Beta', updatedAt: 100, durationSeconds: 60 }),
    makeTrack({ id: 'b', title: 'alpha', updatedAt: 300, durationSeconds: 300 }),
    makeTrack({ id: 'c', title: 'Gamma', updatedAt: 200, durationSeconds: 120, analysis: null }),
  ];

  it('sorts by recency, newest first', () => {
    expect(sortTracks(tracks, 'recent').map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by title case-insensitively', () => {
    expect(sortTracks(tracks, 'title', false).map((t) => t.title)).toEqual([
      'alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('sorts by duration', () => {
    expect(sortTracks(tracks, 'duration', true).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('puts tracks with no analysis last when sorting by BPM', () => {
    expect(sortTracks(tracks, 'bpm', true).map((t) => t.id).at(-1)).toBe('c');
  });

  it('does not mutate the input array', () => {
    const order = tracks.map((t) => t.id);
    sortTracks(tracks, 'title');
    expect(tracks.map((t) => t.id)).toEqual(order);
  });
});

describe('queryTracks', () => {
  const library = makeLibrary(
    [
      makeTrack({ id: 'live', folderId: 'f1' }),
      makeTrack({ id: 'unfiled', folderId: null, title: 'Loose Ends' }),
      makeTrack({ id: 'gone', deletedAt: 5000, title: 'Deleted Thing' }),
    ],
    [{ id: 'f1', name: 'Session', createdAt: 1, order: 0 }],
  );

  it('hides trashed tracks by default', () => {
    expect(queryTracks(library).map((t) => t.id).sort()).toEqual(['live', 'unfiled']);
  });

  it('shows only trashed tracks in trash scope', () => {
    expect(queryTracks(library, { scope: 'trash' }).map((t) => t.id)).toEqual(['gone']);
  });

  it('filters to a folder', () => {
    expect(queryTracks(library, { folderId: 'f1' }).map((t) => t.id)).toEqual(['live']);
  });

  it('treats a null folder as the unfiled root', () => {
    expect(queryTracks(library, { folderId: null }).map((t) => t.id)).toEqual(['unfiled']);
  });

  it('treats an absent folder key as every folder', () => {
    expect(queryTracks(library, {})).toHaveLength(2);
  });

  it('combines a folder filter with a text search', () => {
    expect(queryTracks(library, { folderId: null, text: 'loose' })).toHaveLength(1);
    expect(queryTracks(library, { folderId: 'f1', text: 'loose' })).toHaveLength(0);
  });

  it('filters by stem', () => {
    expect(queryTracks(library, { stems: ['vocals'] })).toHaveLength(2);
    expect(queryTracks(library, { stems: ['piano'] })).toHaveLength(0);
  });
});

describe('folder counts', () => {
  const library = makeLibrary(
    [
      makeTrack({ id: 'a', folderId: 'f1' }),
      makeTrack({ id: 'b', folderId: 'f1' }),
      makeTrack({ id: 'c', folderId: null }),
      makeTrack({ id: 'd', folderId: 'f1', deletedAt: 1 }),
    ],
    [
      { id: 'f1', name: 'One', createdAt: 1, order: 0 },
      { id: 'f2', name: 'Two', createdAt: 2, order: 1 },
    ],
  );

  it('counts live tracks per folder', () => {
    const counts = countByFolder(library);
    expect(counts.f1).toBe(2);
    expect(counts.f2).toBe(0);
    expect(counts.__unfiled__).toBe(1);
  });

  it('excludes trashed tracks from folder counts', () => {
    expect(countByFolder(library).f1).toBe(2);
    expect(trashCount(library)).toBe(1);
  });
});

describe('track mutations', () => {
  const library = makeLibrary([makeTrack({ id: 'a' }), makeTrack({ id: 'b' })]);

  it('adds a new track', () => {
    expect(upsertTrack(library, makeTrack({ id: 'c' })).tracks).toHaveLength(3);
  });

  it('replaces an existing track rather than duplicating it', () => {
    const next = upsertTrack(library, makeTrack({ id: 'a', title: 'Renamed' }));
    expect(next.tracks).toHaveLength(2);
    expect(findTrack(next, 'a')?.title).toBe('Renamed');
  });

  it('patches a track and stamps the update time', () => {
    const next = updateTrack(library, 'a', { title: 'New' }, 9999);
    expect(findTrack(next, 'a')?.title).toBe('New');
    expect(findTrack(next, 'a')?.updatedAt).toBe(9999);
  });

  it('will not let a patch change the id', () => {
    const next = updateTrack(library, 'a', { id: 'hacked' } as Partial<Track>);
    expect(findTrack(next, 'a')).toBeDefined();
    expect(findTrack(next, 'hacked')).toBeUndefined();
  });

  it('moves tracks into an existing folder', () => {
    const withFolder = createFolder(library, 'Session', 'f1');
    const moved = moveTracks(withFolder, ['a'], 'f1');
    expect(findTrack(moved, 'a')?.folderId).toBe('f1');
  });

  it('ignores a move to a folder that does not exist', () => {
    // A drag onto a folder deleted in another window should do nothing,
    // not orphan the track.
    expect(moveTracks(library, ['a'], 'ghost')).toBe(library);
  });

  it('allows a move back to the unfiled root', () => {
    const withFolder = moveTracks(createFolder(library, 'S', 'f1'), ['a'], 'f1');
    expect(findTrack(moveTracks(withFolder, ['a'], null), 'a')?.folderId).toBeNull();
  });
});

describe('trash', () => {
  const library = makeLibrary([makeTrack({ id: 'a' }), makeTrack({ id: 'b' })]);

  it('soft-deletes rather than removing', () => {
    const next = trashTracks(library, ['a'], 5000);
    expect(next.tracks).toHaveLength(2);
    expect(findTrack(next, 'a')?.deletedAt).toBe(5000);
  });

  it('does not restamp a track already in the trash', () => {
    const once = trashTracks(library, ['a'], 5000);
    expect(findTrack(trashTracks(once, ['a'], 9000), 'a')?.deletedAt).toBe(5000);
  });

  it('restores a trashed track', () => {
    const restored = restoreTracks(trashTracks(library, ['a']), ['a']);
    expect(findTrack(restored, 'a')?.deletedAt).toBeNull();
  });

  it('purges only trashed tracks', () => {
    // A mis-sent id must not be able to destroy a live track.
    const next = purgeTracks(trashTracks(library, ['a']), ['a', 'b']);
    expect(next.tracks.map((t) => t.id)).toEqual(['b']);
  });

  it('empties the whole trash', () => {
    const next = emptyTrash(trashTracks(library, ['a', 'b']));
    expect(next.tracks).toHaveLength(0);
  });

  it('reports trash older than the retention window', () => {
    const now = 1_000_000_000;
    const old = now - (TRASH_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    const state = makeLibrary([
      makeTrack({ id: 'old', deletedAt: old }),
      makeTrack({ id: 'recent', deletedAt: now - 1000 }),
      makeTrack({ id: 'live' }),
    ]);
    expect(expiredTrash(state, now).map((t) => t.id)).toEqual(['old']);
  });
});

describe('folders', () => {
  const library = makeLibrary([makeTrack({ id: 'a', folderId: 'f1' })], [
    { id: 'f1', name: 'One', createdAt: 1, order: 0 },
    { id: 'f2', name: 'Two', createdAt: 2, order: 1 },
    { id: 'f3', name: 'Three', createdAt: 3, order: 2 },
  ]);

  it('creates a folder at the end of the order', () => {
    const next = createFolder(library, 'Four', 'f4');
    expect(next.folders.find((f) => f.id === 'f4')?.order).toBe(3);
  });

  it('falls back to a default name for an empty one', () => {
    expect(createFolder(library, '   ', 'f4').folders.at(-1)?.name).toBe('New folder');
  });

  it('renames a folder', () => {
    expect(renameFolder(library, 'f1', 'Renamed').folders[0]?.name).toBe('Renamed');
  });

  it('ignores a rename to whitespace', () => {
    expect(renameFolder(library, 'f1', '  ')).toBe(library);
  });

  it('unfiles tracks instead of deleting them when a folder goes', () => {
    // Deleting a folder must never delete music.
    const next = deleteFolder(library, 'f1');
    expect(next.folders.map((f) => f.id)).toEqual(['f2', 'f3']);
    expect(next.tracks).toHaveLength(1);
    expect(findTrack(next, 'a')?.folderId).toBeNull();
  });

  it('reorders and renumbers', () => {
    const next = reorderFolders(library, 'f3', 0);
    expect(sortedFolders(next).map((f) => f.id)).toEqual(['f3', 'f1', 'f2']);
    expect(sortedFolders(next).map((f) => f.order)).toEqual([0, 1, 2]);
  });

  it('clamps a reorder target beyond the ends', () => {
    expect(sortedFolders(reorderFolders(library, 'f1', 99)).map((f) => f.id)).toEqual([
      'f2',
      'f3',
      'f1',
    ]);
  });

  it('ignores a reorder of an unknown folder', () => {
    expect(reorderFolders(library, 'ghost', 0)).toBe(library);
  });
});

describe('normaliseLibrary', () => {
  it('returns an empty library for junk', () => {
    for (const junk of [null, undefined, 42, 'text', []]) {
      expect(normaliseLibrary(junk).tracks).toEqual([]);
    }
  });

  it('drops entries missing an id or a directory', () => {
    const raw = { tracks: [{ id: 'ok', trackDir: '/x' }, { title: 'no id' }, null] };
    expect(normaliseLibrary(raw).tracks).toHaveLength(1);
  });

  it('repairs missing fields with defaults', () => {
    const track = normaliseLibrary({ tracks: [{ id: 'a', trackDir: '/x' }] }).tracks[0]!;
    expect(track.title).toBe('Untitled');
    expect(track.tags).toEqual([]);
    expect(track.stems).toEqual([]);
    expect(track.deletedAt).toBeNull();
    expect(track.durationSeconds).toBe(0);
  });

  it('unfiles a track pointing at a folder that no longer exists', () => {
    // Otherwise the track would be invisible in every view.
    const raw = { folders: [], tracks: [{ id: 'a', trackDir: '/x', folderId: 'ghost' }] };
    expect(normaliseLibrary(raw).tracks[0]?.folderId).toBeNull();
  });

  it('keeps a valid folder reference', () => {
    const raw = {
      folders: [{ id: 'f1', name: 'One', createdAt: 1, order: 0 }],
      tracks: [{ id: 'a', trackDir: '/x', folderId: 'f1' }],
    };
    expect(normaliseLibrary(raw).tracks[0]?.folderId).toBe('f1');
  });

  it('filters non-string tags and warnings', () => {
    const raw = { tracks: [{ id: 'a', trackDir: '/x', tags: ['ok', 5, null], warnings: [1, 'w'] }] };
    const track = normaliseLibrary(raw).tracks[0]!;
    expect(track.tags).toEqual(['ok']);
    expect(track.warnings).toEqual(['w']);
  });

  it('stamps the current schema version', () => {
    expect(normaliseLibrary({ schemaVersion: 99, tracks: [] }).schemaVersion).toBe(1);
  });
});
