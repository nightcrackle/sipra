/**
 * Library persistence.
 *
 * All the "what does the library look like after this action" logic lives
 * in `shared/library.ts` as pure functions. This class adds the two things
 * that need a real machine: an atomic JSON file, and deleting a track's
 * folder when it is purged from the trash.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createFolder,
  deleteFolder,
  emptyLibrary,
  emptyTrash,
  expiredTrash,
  findTrack,
  moveTracks,
  normaliseLibrary,
  purgeTracks,
  queryTracks,
  renameFolder,
  reorderFolders,
  restoreTracks,
  trashTracks,
  updateTrack,
  upsertTrack,
} from '../../shared/library';
import { isPathInside } from '../../shared/paths';
import type { Folder, LibraryQuery, LibraryState, Track } from '../../shared/types';
import { JsonStore } from './jsonStore';

export class LibraryService extends EventEmitter {
  private readonly store: JsonStore<LibraryState>;

  constructor(
    filePath: string,
    /** Every track directory must live under here. Guards deletion. */
    private readonly workspaceDir: string,
  ) {
    super();
    this.store = new JsonStore<LibraryState>({
      filePath,
      defaults: emptyLibrary,
      normalise: normaliseLibrary,
    });
  }

  get filePath(): string {
    return this.store.path;
  }

  async getState(): Promise<LibraryState> {
    return this.store.read();
  }

  async query(query: LibraryQuery): Promise<Track[]> {
    return queryTracks(await this.getState(), query);
  }

  async getTrack(trackId: string): Promise<Track | undefined> {
    return findTrack(await this.getState(), trackId);
  }

  private async commit(next: LibraryState): Promise<LibraryState> {
    const saved = await this.store.write(next);
    this.emit('changed', saved);
    return saved;
  }

  async addTrack(track: Track): Promise<LibraryState> {
    return this.commit(upsertTrack(await this.getState(), track));
  }

  async patchTrack(trackId: string, patch: Partial<Track>): Promise<LibraryState> {
    return this.commit(updateTrack(await this.getState(), trackId, patch));
  }

  async move(trackIds: string[], folderId: string | null): Promise<LibraryState> {
    return this.commit(moveTracks(await this.getState(), trackIds, folderId));
  }

  async trash(trackIds: string[]): Promise<LibraryState> {
    return this.commit(trashTracks(await this.getState(), trackIds));
  }

  async restore(trackIds: string[]): Promise<LibraryState> {
    return this.commit(restoreTracks(await this.getState(), trackIds));
  }

  /**
   * Delete trashed tracks for good, removing their files.
   *
   * Only tracks currently in the trash are touched, and only directories
   * inside the workspace are removed. A library file edited by hand to
   * point a track at `C:\Windows` must not turn "empty trash" into a
   * disaster.
   */
  async purge(trackIds: string[]): Promise<LibraryState> {
    const state = await this.getState();
    const doomed = state.tracks.filter(
      (track) => trackIds.includes(track.id) && track.deletedAt !== null,
    );
    await Promise.all(doomed.map((track) => this.removeTrackFiles(track)));
    return this.commit(purgeTracks(state, doomed.map((track) => track.id)));
  }

  async emptyTrash(): Promise<LibraryState> {
    const state = await this.getState();
    const doomed = state.tracks.filter((track) => track.deletedAt !== null);
    await Promise.all(doomed.map((track) => this.removeTrackFiles(track)));
    return this.commit(emptyTrash(state));
  }

  /** Remove trash older than the retention window. Runs at startup. */
  async pruneExpiredTrash(): Promise<LibraryState> {
    const state = await this.getState();
    const expired = expiredTrash(state);
    if (expired.length === 0) return state;
    await Promise.all(expired.map((track) => this.removeTrackFiles(track)));
    return this.commit(purgeTracks(state, expired.map((track) => track.id)));
  }

  private async removeTrackFiles(track: Track): Promise<void> {
    if (!track.trackDir) return;
    const resolved = path.resolve(track.trackDir);
    if (!isPathInside(this.workspaceDir, resolved)) {
      this.emit('warning', {
        level: 'warning',
        title: 'Files left in place',
        message: `"${track.title}" is stored outside Sipra's workspace, so its files were not deleted.`,
      });
      return;
    }
    await fs.rm(resolved, { recursive: true, force: true }).catch((error: Error) => {
      this.emit('warning', {
        level: 'warning',
        title: 'Could not delete files',
        message: `Sipra removed "${track.title}" from the library, but its files could not be deleted: ${error.message}`,
      });
    });
  }

  async addFolder(name: string): Promise<{ state: LibraryState; folder: Folder }> {
    const id = randomUUID();
    const next = createFolder(await this.getState(), name, id);
    const state = await this.commit(next);
    const folder = state.folders.find((candidate) => candidate.id === id);
    if (!folder) throw new Error('Folder was not created');
    return { state, folder };
  }

  async renameFolder(folderId: string, name: string): Promise<LibraryState> {
    return this.commit(renameFolder(await this.getState(), folderId, name));
  }

  async deleteFolder(folderId: string): Promise<LibraryState> {
    return this.commit(deleteFolder(await this.getState(), folderId));
  }

  async reorderFolders(folderId: string, targetIndex: number): Promise<LibraryState> {
    return this.commit(reorderFolders(await this.getState(), folderId, targetIndex));
  }

  /**
   * Drop tracks whose files have vanished.
   *
   * People move and delete folders behind an app's back. A library full of
   * rows that fail to play is worse than a library that quietly notices.
   */
  async reconcile(): Promise<{ state: LibraryState; missing: Track[] }> {
    const state = await this.getState();
    const missing: Track[] = [];
    for (const track of state.tracks) {
      if (track.deletedAt !== null) continue;
      try {
        await fs.access(track.sourcePath);
      } catch {
        missing.push(track);
      }
    }
    if (missing.length === 0) return { state, missing };
    const next = trashTracks(state, missing.map((track) => track.id));
    return { state: await this.commit(next), missing };
  }
}
