/**
 * The preload bridge.
 *
 * This is the entire surface the renderer can reach. Each method is a
 * thin, named wrapper around one channel — no generic `invoke(channel,
 * ...args)` escape hatch, because that would let any injected script in
 * the renderer call anything the main process handles.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS, EVENTS, type SipraApi } from '../shared/ipc';

/** Subscribe to a main-process event and return an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: SipraApi = {
  appInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),

  runtime: {
    status: () => ipcRenderer.invoke(CHANNELS.runtimeStatus),
    install: () => ipcRenderer.invoke(CHANNELS.runtimeInstall),
    capabilities: () => ipcRenderer.invoke(CHANNELS.runtimeCapabilities),
    onChanged: (listener) => subscribe(EVENTS.runtimeChanged, listener),
  },

  library: {
    get: () => ipcRenderer.invoke(CHANNELS.libraryGet),
    query: (query) => ipcRenderer.invoke(CHANNELS.libraryQuery, query),
    updateTrack: (trackId, patch) =>
      ipcRenderer.invoke(CHANNELS.libraryUpdateTrack, trackId, patch),
    moveTracks: (trackIds, folderId) =>
      ipcRenderer.invoke(CHANNELS.libraryMoveTracks, trackIds, folderId),
    trashTracks: (trackIds) => ipcRenderer.invoke(CHANNELS.libraryTrashTracks, trackIds),
    restoreTracks: (trackIds) => ipcRenderer.invoke(CHANNELS.libraryRestoreTracks, trackIds),
    purgeTracks: (trackIds) => ipcRenderer.invoke(CHANNELS.libraryPurgeTracks, trackIds),
    emptyTrash: () => ipcRenderer.invoke(CHANNELS.libraryEmptyTrash),
    createFolder: (name) => ipcRenderer.invoke(CHANNELS.libraryCreateFolder, name),
    renameFolder: (folderId, name) =>
      ipcRenderer.invoke(CHANNELS.libraryRenameFolder, folderId, name),
    deleteFolder: (folderId) => ipcRenderer.invoke(CHANNELS.libraryDeleteFolder, folderId),
    reorderFolders: (folderId, targetIndex) =>
      ipcRenderer.invoke(CHANNELS.libraryReorderFolders, folderId, targetIndex),
    onChanged: (listener) => subscribe(EVENTS.libraryChanged, listener),
  },

  tracks: {
    separate: (request) => ipcRenderer.invoke(CHANNELS.tracksSeparate, request),
    reanalyse: (trackId) => ipcRenderer.invoke(CHANNELS.tracksReanalyse, trackId),
    exportStem: (trackId, stemId, targetPath) =>
      ipcRenderer.invoke(CHANNELS.tracksExportStem, trackId, stemId, targetPath),
    exportMix: (request) => ipcRenderer.invoke(CHANNELS.tracksExportMix, request),
    reveal: (trackId) => ipcRenderer.invoke(CHANNELS.tracksRevealInFolder, trackId),
  },

  jobs: {
    list: () => ipcRenderer.invoke(CHANNELS.jobsList),
    cancel: (jobId) => ipcRenderer.invoke(CHANNELS.jobsCancel, jobId),
    onUpdated: (listener) => subscribe(EVENTS.jobUpdated, listener),
  },

  files: {
    pickAudio: () => ipcRenderer.invoke(CHANNELS.filesPickAudio),
    pickSaveTarget: (suggestedName, extensions) =>
      ipcRenderer.invoke(CHANNELS.filesPickSaveTarget, suggestedName, extensions),
    pickDirectory: () => ipcRenderer.invoke(CHANNELS.filesPickDirectory),
    readPeaks: (trackId, stemId) => ipcRenderer.invoke(CHANNELS.filesReadPeaks, trackId, stemId),
    resolveDropped: (paths) => ipcRenderer.invoke(CHANNELS.filesResolveDropped, paths),
  },

  youtube: {
    status: () => ipcRenderer.invoke(CHANNELS.youtubeStatus),
    diagnose: () => ipcRenderer.invoke(CHANNELS.youtubeDiagnose),
    metadata: (url) => ipcRenderer.invoke(CHANNELS.youtubeMetadata, url),
    import: (url, rightsConfirmed, folderId) =>
      ipcRenderer.invoke(CHANNELS.youtubeImport, url, rightsConfirmed, folderId),
  },

  settings: {
    get: () => ipcRenderer.invoke(CHANNELS.settingsGet),
    set: (patch) => ipcRenderer.invoke(CHANNELS.settingsSet, patch),
  },

  notices: {
    on: (listener) => subscribe(EVENTS.notice, listener),
  },
};

contextBridge.exposeInMainWorld('sipra', api);
