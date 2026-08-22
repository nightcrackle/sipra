import { describe, expect, it } from 'vitest';

import { mediaUrl } from '@shared/ipc';
import { emptyLibrary } from '@shared/library';
import type { LibraryState, Track } from '@shared/types';

import {
  contentTypeFor,
  MediaRequestError,
  parseMediaUrl,
  resolveMediaPath,
} from '../electron/services/media';

const WORKSPACE = '/ws';

const track: Track = {
  id: 'track-1',
  title: 'Song',
  artist: null,
  createdAt: 0,
  updatedAt: 0,
  folderId: null,
  trackDir: '/ws/tracks/song',
  sourcePath: '/ws/tracks/song/source.wav',
  sourcePeaksPath: '/ws/tracks/song/peaks/source.speaks',
  originalFileName: 'song.mp3',
  sourceUrl: null,
  fingerprint: null,
  durationSeconds: 10,
  sampleRate: 44100,
  channels: 2,
  engineId: 'demucs',
  modelId: 'htdemucs',
  device: 'CPU',
  stems: [
    {
      id: 'vocals',
      audioPath: '/ws/tracks/song/stems/vocals.wav',
      peaksPath: '/ws/tracks/song/peaks/vocals.speaks',
      samplePeakDb: -1,
      rmsDb: -14,
    },
  ],
  analysis: null,
  tags: [],
  notes: '',
  deletedAt: null,
  warnings: [],
};

const library: LibraryState = { ...emptyLibrary(), tracks: [track] };

describe('parseMediaUrl', () => {
  it('parses a source request', () => {
    expect(parseMediaUrl('sipra://media/track-1/source')).toEqual({
      trackId: 'track-1',
      kind: 'source',
      stemId: null,
    });
  });

  it('parses a stem request', () => {
    expect(parseMediaUrl('sipra://media/track-1/stem/vocals')).toEqual({
      trackId: 'track-1',
      kind: 'stem',
      stemId: 'vocals',
    });
  });

  it('round-trips a URL built by the shared helper', () => {
    const parsed = parseMediaUrl(mediaUrl('track-1', 'peaks-stem', 'drums'));
    expect(parsed).toEqual({ trackId: 'track-1', kind: 'peaks-stem', stemId: 'drums' });
  });

  it('decodes percent-encoded ids', () => {
    const parsed = parseMediaUrl(mediaUrl('a b/c', 'source'));
    expect(parsed.trackId).toBe('a b/c');
  });

  it('rejects another scheme', () => {
    expect(() => parseMediaUrl('file:///etc/passwd')).toThrow(MediaRequestError);
    expect(() => parseMediaUrl('http://evil.com/x')).toThrow(/scheme/);
  });

  it('rejects an unknown host', () => {
    expect(() => parseMediaUrl('sipra://elsewhere/track-1/source')).toThrow(/host/);
  });

  it('rejects a malformed URL', () => {
    expect(() => parseMediaUrl('not a url')).toThrow(/Malformed/);
  });

  it('rejects an incomplete path', () => {
    expect(() => parseMediaUrl('sipra://media/track-1')).toThrow(/Incomplete/);
    expect(() => parseMediaUrl('sipra://media/')).toThrow(/Incomplete/);
  });

  it('rejects an unknown asset kind', () => {
    expect(() => parseMediaUrl('sipra://media/track-1/secrets')).toThrow(/asset kind/);
  });

  it('requires a stem id for stem kinds', () => {
    expect(() => parseMediaUrl('sipra://media/track-1/stem')).toThrow(/stem id/);
    expect(() => parseMediaUrl('sipra://media/track-1/peaks-stem')).toThrow(/stem id/);
  });
});

describe('resolveMediaPath', () => {
  it('resolves the source audio', () => {
    const resolved = resolveMediaPath(
      { trackId: 'track-1', kind: 'source', stemId: null },
      library,
      WORKSPACE,
    );
    expect(resolved.filePath).toBe('/ws/tracks/song/source.wav');
    expect(resolved.contentType).toBe('audio/wav');
  });

  it('resolves the source peaks', () => {
    const resolved = resolveMediaPath(
      { trackId: 'track-1', kind: 'peaks-source', stemId: null },
      library,
      WORKSPACE,
    );
    expect(resolved.filePath).toBe('/ws/tracks/song/peaks/source.speaks');
  });

  it('resolves a stem and its peaks', () => {
    expect(
      resolveMediaPath({ trackId: 'track-1', kind: 'stem', stemId: 'vocals' }, library, WORKSPACE)
        .filePath,
    ).toBe('/ws/tracks/song/stems/vocals.wav');
    expect(
      resolveMediaPath(
        { trackId: 'track-1', kind: 'peaks-stem', stemId: 'vocals' },
        library,
        WORKSPACE,
      ).filePath,
    ).toBe('/ws/tracks/song/peaks/vocals.speaks');
  });

  it('rejects an unknown track', () => {
    expect(() =>
      resolveMediaPath({ trackId: 'ghost', kind: 'source', stemId: null }, library, WORKSPACE),
    ).toThrow(/Unknown track/);
  });

  it('rejects a stem the track does not have', () => {
    expect(() =>
      resolveMediaPath({ trackId: 'track-1', kind: 'stem', stemId: 'piano' }, library, WORKSPACE),
    ).toThrow(/Unknown asset/);
  });

  it('refuses a path outside the workspace', () => {
    // A hand-edited library file must not turn the media scheme into an
    // arbitrary file reader.
    const escaped: LibraryState = {
      ...library,
      tracks: [{ ...track, sourcePath: '/etc/passwd' }],
    };
    expect(() =>
      resolveMediaPath({ trackId: 'track-1', kind: 'source', stemId: null }, escaped, WORKSPACE),
    ).toThrow(/outside the workspace/);
  });

  it('refuses a traversal that escapes the workspace once resolved', () => {
    const escaped: LibraryState = {
      ...library,
      tracks: [{ ...track, sourcePath: '/ws/../etc/shadow' }],
    };
    expect(() =>
      resolveMediaPath({ trackId: 'track-1', kind: 'source', stemId: null }, escaped, WORKSPACE),
    ).toThrow(/outside the workspace/);
  });

  it('reports the right HTTP status for each failure', () => {
    try {
      resolveMediaPath({ trackId: 'ghost', kind: 'source', stemId: null }, library, WORKSPACE);
      expect.unreachable();
    } catch (error) {
      expect((error as MediaRequestError).status).toBe(404);
    }

    const escaped: LibraryState = { ...library, tracks: [{ ...track, sourcePath: '/etc/passwd' }] };
    try {
      resolveMediaPath({ trackId: 'track-1', kind: 'source', stemId: null }, escaped, WORKSPACE);
      expect.unreachable();
    } catch (error) {
      expect((error as MediaRequestError).status).toBe(403);
    }
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['a.wav', 'audio/wav'],
    ['a.flac', 'audio/flac'],
    ['a.mp3', 'audio/mpeg'],
    ['a.ogg', 'audio/ogg'],
    ['a.opus', 'audio/opus'],
    ['a.m4a', 'audio/mp4'],
    ['a.aiff', 'audio/aiff'],
    ['a.speaks', 'application/octet-stream'],
    ['a.unknown', 'application/octet-stream'],
  ])('maps %s correctly', (file, expected) => {
    expect(contentTypeFor(file)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(contentTypeFor('LOUD.WAV')).toBe('audio/wav');
  });
});
