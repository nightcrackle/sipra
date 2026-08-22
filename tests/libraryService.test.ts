import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Track } from '@shared/types';

import { LibraryService } from '../electron/services/library';

let workspace: string;
let service: LibraryService;

function makeTrack(id: string, trackDir: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    folderId: null,
    trackDir,
    sourcePath: path.join(trackDir, 'source.wav'),
    sourcePeaksPath: path.join(trackDir, 'peaks', 'source.speaks'),
    originalFileName: `${id}.mp3`,
    sourceUrl: null,
    fingerprint: null,
    durationSeconds: 100,
    sampleRate: 44100,
    channels: 2,
    engineId: 'demucs',
    modelId: 'htdemucs',
    device: 'CPU',
    stems: [],
    analysis: null,
    tags: [],
    notes: '',
    deletedAt: null,
    warnings: [],
    ...overrides,
  };
}

/** Create a track directory with a source file in it. */
async function seedTrack(id: string): Promise<Track> {
  const trackDir = path.join(workspace, 'tracks', id);
  await fs.mkdir(path.join(trackDir, 'peaks'), { recursive: true });
  await fs.writeFile(path.join(trackDir, 'source.wav'), 'audio');
  return makeTrack(id, trackDir);
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-lib-'));
  service = new LibraryService(path.join(workspace, 'library.json'), workspace);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('LibraryService', () => {
  it('starts empty', async () => {
    const state = await service.getState();
    expect(state.tracks).toEqual([]);
    expect(state.folders).toEqual([]);
  });

  it('adds and finds a track', async () => {
    await service.addTrack(await seedTrack('a'));
    expect((await service.getTrack('a'))?.title).toBe('Track a');
  });

  it('persists across instances', async () => {
    await service.addTrack(await seedTrack('a'));
    const reopened = new LibraryService(path.join(workspace, 'library.json'), workspace);
    expect((await reopened.getState()).tracks).toHaveLength(1);
  });

  it('announces a change', async () => {
    const listener = vi.fn();
    service.on('changed', listener);
    await service.addTrack(await seedTrack('a'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('patches a track', async () => {
    await service.addTrack(await seedTrack('a'));
    await service.patchTrack('a', { title: 'Renamed' });
    expect((await service.getTrack('a'))?.title).toBe('Renamed');
  });

  it('queries with a filter', async () => {
    await service.addTrack({ ...(await seedTrack('a')), title: 'Midnight Drive' });
    await service.addTrack({ ...(await seedTrack('b')), title: 'Sunrise' });
    expect(await service.query({ text: 'midnight' })).toHaveLength(1);
    expect(await service.query({ text: 'e' })).toHaveLength(2);
  });

  it('moves tracks into a folder', async () => {
    await service.addTrack(await seedTrack('a'));
    const { folder } = await service.addFolder('Session');
    await service.move(['a'], folder.id);
    expect((await service.getTrack('a'))?.folderId).toBe(folder.id);
  });

  it('unfiles tracks when their folder is deleted', async () => {
    await service.addTrack(await seedTrack('a'));
    const { folder } = await service.addFolder('Session');
    await service.move(['a'], folder.id);
    await service.deleteFolder(folder.id);
    expect((await service.getTrack('a'))?.folderId).toBeNull();
  });

  it('keeps files on disk when a track is trashed', async () => {
    const track = await seedTrack('a');
    await service.addTrack(track);
    await service.trash(['a']);
    await expect(fs.access(track.sourcePath)).resolves.toBeUndefined();
  });

  it('deletes files when a trashed track is purged', async () => {
    const track = await seedTrack('a');
    await service.addTrack(track);
    await service.trash(['a']);
    await service.purge(['a']);
    await expect(fs.access(track.trackDir)).rejects.toThrow();
    expect(await service.getTrack('a')).toBeUndefined();
  });

  it('refuses to purge a track that is not in the trash', async () => {
    const track = await seedTrack('a');
    await service.addTrack(track);
    await service.purge(['a']);
    await expect(fs.access(track.sourcePath)).resolves.toBeUndefined();
    expect(await service.getTrack('a')).toBeDefined();
  });

  it('empties the trash and removes those files', async () => {
    const first = await seedTrack('a');
    const second = await seedTrack('b');
    await service.addTrack(first);
    await service.addTrack(second);
    await service.trash(['a']);
    await service.emptyTrash();
    await expect(fs.access(first.trackDir)).rejects.toThrow();
    await expect(fs.access(second.trackDir)).resolves.toBeUndefined();
  });

  it('will not delete a directory outside the workspace', async () => {
    // A hand-edited library file must not turn "empty trash" into a
    // disaster somewhere else on the disk.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-outside-'));
    await fs.writeFile(path.join(outside, 'important.txt'), 'keep me');
    try {
      await service.addTrack(makeTrack('escapee', outside, { deletedAt: Date.now() }));
      const warning = vi.fn();
      service.on('warning', warning);
      await service.purge(['escapee']);
      await expect(fs.access(path.join(outside, 'important.txt'))).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('removes the track from the index even when its files could not be deleted', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-outside-'));
    try {
      await service.addTrack(makeTrack('escapee', outside, { deletedAt: Date.now() }));
      await service.purge(['escapee']);
      expect(await service.getTrack('escapee')).toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('restores a trashed track', async () => {
    await service.addTrack(await seedTrack('a'));
    await service.trash(['a']);
    await service.restore(['a']);
    expect((await service.getTrack('a'))?.deletedAt).toBeNull();
  });

  it('prunes trash older than the retention window', async () => {
    const track = await seedTrack('a');
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await service.addTrack({ ...track, deletedAt: old });
    await service.pruneExpiredTrash();
    expect(await service.getTrack('a')).toBeUndefined();
    await expect(fs.access(track.trackDir)).rejects.toThrow();
  });

  it('leaves recent trash alone when pruning', async () => {
    await service.addTrack({ ...(await seedTrack('a')), deletedAt: Date.now() });
    await service.pruneExpiredTrash();
    expect(await service.getTrack('a')).toBeDefined();
  });

  it('trashes tracks whose files have vanished', async () => {
    // People move and delete folders behind an app's back; a library full
    // of rows that fail to play is worse than one that notices.
    const track = await seedTrack('a');
    await service.addTrack(track);
    await fs.rm(track.trackDir, { recursive: true, force: true });
    const { missing } = await service.reconcile();
    expect(missing.map((t) => t.id)).toEqual(['a']);
    expect((await service.getTrack('a'))?.deletedAt).not.toBeNull();
  });

  it('leaves an intact library untouched when reconciling', async () => {
    await service.addTrack(await seedTrack('a'));
    const { missing } = await service.reconcile();
    expect(missing).toEqual([]);
  });

  it('creates, renames and reorders folders', async () => {
    const first = await service.addFolder('One');
    const second = await service.addFolder('Two');
    await service.renameFolder(first.folder.id, 'Renamed');
    const state = await service.reorderFolders(second.folder.id, 0);
    const ordered = [...state.folders].sort((a, b) => a.order - b.order);
    expect(ordered.map((folder) => folder.name)).toEqual(['Two', 'Renamed']);
  });
});
