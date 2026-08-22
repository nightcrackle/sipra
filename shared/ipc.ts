/**
 * The contract between the Electron main process and the renderer.
 *
 * The renderer has no Node integration and no direct filesystem access.
 * Everything it can do is one of the channels below, exposed through the
 * preload bridge as `window.sipra`.
 */

import type {
  Capabilities,
  ExportMixRequest,
  Folder,
  Job,
  LibraryQuery,
  LibraryState,
  RuntimeStatus,
  SeparateRequest,
  Settings,
  Track,
} from './types';

export const CHANNELS = {
  appInfo: 'app:info',

  runtimeStatus: 'runtime:status',
  runtimeInstall: 'runtime:install',
  runtimeCapabilities: 'runtime:capabilities',

  libraryGet: 'library:get',
  libraryQuery: 'library:query',
  libraryUpdateTrack: 'library:update-track',
  libraryMoveTracks: 'library:move-tracks',
  libraryTrashTracks: 'library:trash-tracks',
  libraryRestoreTracks: 'library:restore-tracks',
  libraryPurgeTracks: 'library:purge-tracks',
  libraryEmptyTrash: 'library:empty-trash',
  libraryCreateFolder: 'library:create-folder',
  libraryRenameFolder: 'library:rename-folder',
  libraryDeleteFolder: 'library:delete-folder',
  libraryReorderFolders: 'library:reorder-folders',

  tracksSeparate: 'tracks:separate',
  tracksReanalyse: 'tracks:reanalyse',
  tracksExportStem: 'tracks:export-stem',
  tracksExportMix: 'tracks:export-mix',
  tracksRevealInFolder: 'tracks:reveal',

  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',

  filesPickAudio: 'files:pick-audio',
  filesPickSaveTarget: 'files:pick-save-target',
  filesPickDirectory: 'files:pick-directory',
  filesReadPeaks: 'files:read-peaks',
  filesResolveDropped: 'files:resolve-dropped',

  youtubeStatus: 'youtube:status',
  youtubeMetadata: 'youtube:metadata',
  youtubeImport: 'youtube:import',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
} as const;

export const EVENTS = {
  runtimeChanged: 'event:runtime-changed',
  jobUpdated: 'event:job-updated',
  libraryChanged: 'event:library-changed',
  notice: 'event:notice',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Custom scheme used to stream audio and peak files into the renderer. */
export const MEDIA_SCHEME = 'sipra';

export type MediaAssetKind = 'source' | 'stem' | 'peaks-source' | 'peaks-stem';

/**
 * Build a media URL.
 *
 * Track and stem *ids* are used rather than filesystem paths, so the
 * renderer never learns a real path and a crafted URL cannot escape the
 * workspace — main resolves ids against the library and refuses anything
 * it does not recognise.
 */
export function mediaUrl(trackId: string, kind: MediaAssetKind, stemId?: string): string {
  const suffix = stemId ? `/${encodeURIComponent(stemId)}` : '';
  return `${MEDIA_SCHEME}://media/${encodeURIComponent(trackId)}/${kind}${suffix}`;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  workspaceDir: string;
  isPackaged: boolean;
  bundledYtdlp: boolean;
}

export interface Notice {
  level: 'info' | 'warning' | 'error';
  title: string;
  message: string;
}

export interface ImportResult {
  track: Track | null;
  jobId: string;
}

/** The surface exposed to the renderer as `window.sipra`. */
export interface SipraApi {
  appInfo(): Promise<AppInfo>;

  runtime: {
    status(): Promise<RuntimeStatus>;
    install(): Promise<RuntimeStatus>;
    capabilities(): Promise<Capabilities | null>;
    onChanged(listener: (status: RuntimeStatus) => void): () => void;
  };

  library: {
    get(): Promise<LibraryState>;
    query(query: LibraryQuery): Promise<Track[]>;
    updateTrack(trackId: string, patch: Partial<Track>): Promise<LibraryState>;
    moveTracks(trackIds: string[], folderId: string | null): Promise<LibraryState>;
    trashTracks(trackIds: string[]): Promise<LibraryState>;
    restoreTracks(trackIds: string[]): Promise<LibraryState>;
    purgeTracks(trackIds: string[]): Promise<LibraryState>;
    emptyTrash(): Promise<LibraryState>;
    createFolder(name: string): Promise<{ state: LibraryState; folder: Folder }>;
    renameFolder(folderId: string, name: string): Promise<LibraryState>;
    deleteFolder(folderId: string): Promise<LibraryState>;
    reorderFolders(folderId: string, targetIndex: number): Promise<LibraryState>;
    onChanged(listener: (state: LibraryState) => void): () => void;
  };

  tracks: {
    separate(request: SeparateRequest): Promise<ImportResult>;
    reanalyse(trackId: string): Promise<{ jobId: string }>;
    exportStem(trackId: string, stemId: string, targetPath: string): Promise<{ path: string }>;
    exportMix(request: ExportMixRequest): Promise<{ jobId: string }>;
    reveal(trackId: string): Promise<void>;
  };

  jobs: {
    list(): Promise<Job[]>;
    cancel(jobId: string): Promise<boolean>;
    onUpdated(listener: (job: Job) => void): () => void;
  };

  files: {
    pickAudio(): Promise<string[]>;
    pickSaveTarget(suggestedName: string, extensions: string[]): Promise<string | null>;
    pickDirectory(): Promise<string | null>;
    readPeaks(trackId: string, stemId: string | null): Promise<ArrayBuffer | null>;
    resolveDropped(paths: string[]): Promise<{ accepted: string[]; rejected: string[] }>;
  };

  youtube: {
    status(): Promise<{ available: boolean; allowedHosts: string[]; maxDurationSeconds: number }>;
    metadata(url: string): Promise<{
      title: string;
      durationSeconds: number | null;
      uploader: string | null;
      sourceUrl: string;
    }>;
    import(url: string, rightsConfirmed: boolean, folderId: string | null): Promise<ImportResult>;
  };

  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };

  notices: {
    on(listener: (notice: Notice) => void): () => void;
  };
}

declare global {
  interface Window {
    sipra: SipraApi;
  }
}
