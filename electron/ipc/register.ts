/**
 * IPC handlers.
 *
 * Every handler validates its arguments before doing anything: the
 * renderer is sandboxed but not trusted, and a malformed payload should
 * produce a clear error rather than an exception deep inside a service.
 *
 * Errors thrown here cross the bridge as `{ code, message }` so the UI can
 * say something useful instead of "Error invoking remote method".
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { app, type BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { type AppInfo, CHANNELS, EVENTS, type Notice } from '../../shared/ipc';
import { hasAudioExtension } from '../../shared/paths';
import { isStemId } from '../../shared/stems';
import type {
  Capabilities,
  ExportMixRequest,
  Job,
  LibraryQuery,
  LibraryState,
  SeparateRequest,
  Settings,
} from '../../shared/types';
import { pickTrackPatch } from './sanitise';
import type { JobRegistry } from '../services/jobs';
import type { LibraryService } from '../services/library';
import type { DiagnosticLog } from '../services/logger';
import { resolveMediaPath } from '../services/media';
import type { RuntimeManager } from '../services/runtime';
import type { SettingsService } from '../services/settings';
import { LONG_REQUEST_TIMEOUT_MS, type Sidecar, SidecarError } from '../services/sidecar';
import {
  DOWNLOAD_SHARE,
  stemsForPreset,
  WorkspaceService,
  workspaceLayout,
} from '../services/workspace';

export interface IpcContext {
  settings: SettingsService;
  library: LibraryService;
  jobs: JobRegistry;
  sidecar: Sidecar;
  runtime: RuntimeManager;
  log: DiagnosticLog;
  getWindow: () => BrowserWindow | null;
  resourcePath: (...segments: string[]) => string;
  workspaceRoot: string;
  isDev: boolean;
}

class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new IpcError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new IpcError('INVALID_ARGUMENT', `${name} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Normalise anything thrown in a handler into a payload the renderer can
 * read. Electron flattens an Error to its message otherwise, losing the
 * error code the UI branches on.
 */
function toIpcError(error: unknown): Error {
  if (error instanceof SidecarError) {
    const wrapped = new Error(error.message);
    wrapped.name = error.code;
    Object.assign(wrapped, { code: error.code, details: error.details });
    return wrapped;
  }
  if (error instanceof IpcError) {
    const wrapped = new Error(error.message);
    wrapped.name = error.code;
    Object.assign(wrapped, { code: error.code, details: error.details });
    return wrapped;
  }
  const wrapped = new Error((error as Error)?.message ?? 'Unexpected error');
  Object.assign(wrapped, { code: 'INTERNAL' });
  return wrapped;
}

function handle(channel: string, handler: (...args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw toIpcError(error);
    }
  });
}

export function registerIpc(context: IpcContext): void {
  const { settings, library, jobs, sidecar, runtime, log, getWindow } = context;
  const layout = workspaceLayout(context.workspaceRoot);
  const workspace = new WorkspaceService(layout, sidecar, library, jobs);

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const notify = (notice: Notice): void => send(EVENTS.notice, notice);

  runtime.on('changed', (status) => send(EVENTS.runtimeChanged, status));
  library.on('changed', (state: LibraryState) => send(EVENTS.libraryChanged, state));
  library.on('warning', (notice: Notice) => notify(notice));
  jobs.on('updated', (job: Job) => send(EVENTS.jobUpdated, job));

  sidecar.on('exit', ({ expected }: { expected: boolean }) => {
    if (expected) return;
    notify({
      level: 'error',
      title: 'Audio engine stopped',
      message:
        'The audio engine stopped unexpectedly. The next action you take will restart it; ' +
        'any job that was running has been cancelled.',
    });
    for (const job of jobs.active()) jobs.fail(job.id, {
      code: 'SIDECAR_EXITED',
      message: 'The audio engine stopped before this finished.',
    });
  });

  /**
   * Ensure the runtime exists and the sidecar is pointed at it.
   *
   * Called before anything that needs Python, so the user never has to
   * think about a separate "start engine" step.
   */
  async function ensureRuntime(): Promise<void> {
    let status = runtime.getStatus();
    if (status.stage !== 'ready') {
      status = await runtime.detect();
    }
    if (status.stage !== 'ready') {
      status = await runtime.install();
    }
    if (status.stage !== 'ready' || !status.pythonPath) {
      throw new IpcError(
        status.error?.code ?? 'RUNTIME_NOT_READY',
        status.error?.message ?? 'Sipra is still setting up its audio runtime.',
      );
    }
    sidecar.configure({
      pythonPath: status.pythonPath,
      cwd: context.resourcePath('python'),
      env: {
        SIPRA_BIN_DIR: context.resourcePath('bin'),
        SIPRA_FFMPEG: context.resourcePath(
          'bin',
          process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
        ),
      },
    });
    await sidecar.start();
  }

  // -- app -------------------------------------------------------------

  handle(CHANNELS.appInfo, async (): Promise<AppInfo> => {
    return {
      name: 'Sipra',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      arch: process.arch,
      workspaceDir: context.workspaceRoot,
      isPackaged: app.isPackaged,
      bundledYtdlp: await fileExists(
        context.resourcePath('bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
      ),
    };
  });

  // -- runtime ---------------------------------------------------------

  handle(CHANNELS.runtimeStatus, async () => runtime.getStatus());

  handle(CHANNELS.runtimeInstall, async () => {
    const status = await runtime.install();
    if (status.stage === 'ready' && status.pythonPath) {
      await ensureRuntime().catch(() => undefined);
    }
    return runtime.getStatus();
  });

  handle(CHANNELS.runtimeCapabilities, async (): Promise<Capabilities | null> => {
    const cached = runtime.getStatus().capabilities;
    if (cached) return cached;
    await ensureRuntime();
    const capabilities = await sidecar.request<Capabilities>('capabilities', {}, 120_000);
    runtime.patchStatus({ capabilities, sidecarReady: true });
    return capabilities;
  });

  // -- library ---------------------------------------------------------

  handle(CHANNELS.libraryGet, async () => library.getState());

  handle(CHANNELS.libraryQuery, async (rawQuery) => {
    const query = (rawQuery ?? {}) as LibraryQuery;
    return library.query(query);
  });

  handle(CHANNELS.libraryUpdateTrack, async (trackId, patch) => {
    const id = requireString(trackId, 'trackId');
    const safe = pickTrackPatch(patch);
    return library.patchTrack(id, safe);
  });

  handle(CHANNELS.libraryMoveTracks, async (trackIds, folderId) => {
    const ids = requireStringArray(trackIds, 'trackIds');
    if (folderId !== null && typeof folderId !== 'string') {
      throw new IpcError('INVALID_ARGUMENT', 'folderId must be a string or null');
    }
    return library.move(ids, folderId);
  });

  handle(CHANNELS.libraryTrashTracks, async (trackIds) =>
    library.trash(requireStringArray(trackIds, 'trackIds')),
  );
  handle(CHANNELS.libraryRestoreTracks, async (trackIds) =>
    library.restore(requireStringArray(trackIds, 'trackIds')),
  );
  handle(CHANNELS.libraryPurgeTracks, async (trackIds) =>
    library.purge(requireStringArray(trackIds, 'trackIds')),
  );
  handle(CHANNELS.libraryEmptyTrash, async () => library.emptyTrash());
  handle(CHANNELS.libraryCreateFolder, async (name) =>
    library.addFolder(requireString(name, 'name')),
  );
  handle(CHANNELS.libraryRenameFolder, async (folderId, name) =>
    library.renameFolder(requireString(folderId, 'folderId'), requireString(name, 'name')),
  );
  handle(CHANNELS.libraryDeleteFolder, async (folderId) =>
    library.deleteFolder(requireString(folderId, 'folderId')),
  );
  handle(CHANNELS.libraryReorderFolders, async (folderId, targetIndex) => {
    if (typeof targetIndex !== 'number' || !Number.isFinite(targetIndex)) {
      throw new IpcError('INVALID_ARGUMENT', 'targetIndex must be a number');
    }
    return library.reorderFolders(requireString(folderId, 'folderId'), targetIndex);
  });

  // -- tracks ----------------------------------------------------------

  handle(CHANNELS.tracksSeparate, async (rawRequest) => {
    const request = rawRequest as SeparateRequest;
    requireString(request?.path, 'path');
    await ensureRuntime();

    const currentSettings = await settings.get();
    const job = jobs.create({
      kind: 'separate',
      label: request.title ?? path.basename(request.path),
    });

    // Resolved here rather than in the renderer so the stem set always
    // matches what the chosen model can actually produce.
    const capabilities = runtime.getStatus().capabilities;
    const model = capabilities?.engines
      .find((engine) => engine.id === (request.engineId ?? currentSettings.engineId))
      ?.models.find((candidate) => candidate.id === (request.modelId ?? currentSettings.modelId));
    const stems =
      request.stems ??
      (model ? stemsForPreset(currentSettings.stemPreset, model.stems) : undefined);

    void workspace
      .importAndSeparate({
        request: { ...request, ...(stems ? { stems } : {}) },
        settings: currentSettings,
        jobId: job.id,
      })
      .then((track) => {
        jobs.succeed(job.id);
        if (track.warnings.length > 0) {
          notify({
            level: 'info',
            title: `Separated "${track.title}"`,
            message: track.warnings.join(' '),
          });
        }
      })
      .catch((error: unknown) => {
        const payload =
          error instanceof SidecarError
            ? error.toPayload()
            : { code: 'INTERNAL', message: (error as Error).message };
        if (payload.code === 'CANCELLED') jobs.cancel(job.id);
        else jobs.fail(job.id, payload);
      });

    return { track: null, jobId: job.id };
  });

  handle(CHANNELS.tracksReanalyse, async (trackId) => {
    const id = requireString(trackId, 'trackId');
    await ensureRuntime();
    const track = await library.getTrack(id);
    if (!track) throw new IpcError('UNKNOWN_TRACK', 'That track is no longer in the library.');

    const job = jobs.create({ kind: 'analyze', label: `Analysing ${track.title}`, trackId: id });
    void workspace
      .reanalyse(id, job.id)
      .then(() => jobs.succeed(job.id))
      .catch((error: unknown) =>
        jobs.fail(job.id, {
          code: error instanceof SidecarError ? error.code : 'INTERNAL',
          message: (error as Error).message,
        }),
      );
    return { jobId: job.id };
  });

  handle(CHANNELS.tracksExportStem, async (trackId, stemId, targetPath) => {
    const id = requireString(trackId, 'trackId');
    const stem = requireString(stemId, 'stemId');
    const target = requireString(targetPath, 'targetPath');
    if (!isStemId(stem)) throw new IpcError('INVALID_ARGUMENT', `Unknown stem '${stem}'`);

    const state = await library.getState();
    const { filePath } = resolveMediaPath(
      { trackId: id, kind: 'stem', stemId: stem },
      state,
      context.workspaceRoot,
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(filePath, target);
    return { path: target };
  });

  handle(CHANNELS.tracksExportMix, async (rawRequest) => {
    const request = rawRequest as ExportMixRequest;
    const id = requireString(request?.trackId, 'trackId');
    const outputPath = requireString(request?.outputPath, 'outputPath');
    if (!Array.isArray(request.lanes) || request.lanes.length === 0) {
      throw new IpcError('INVALID_ARGUMENT', 'lanes must be a non-empty array');
    }
    await ensureRuntime();

    const track = await library.getTrack(id);
    if (!track) throw new IpcError('UNKNOWN_TRACK', 'That track is no longer in the library.');

    const byId = new Map(track.stems.map((stem) => [stem.id, stem]));
    const tracks = request.lanes
      .filter((lane) => byId.has(lane.stemId))
      .map((lane) => ({
        path: byId.get(lane.stemId)?.audioPath,
        gainDb: Number.isFinite(lane.gainDb) ? lane.gainDb : 0,
        muted: Boolean(lane.muted),
        solo: Boolean(lane.solo),
      }));
    if (tracks.length === 0) {
      throw new IpcError('INVALID_ARGUMENT', 'None of those stems belong to this track.');
    }

    const job = jobs.create({ kind: 'export', label: `Exporting ${track.title}`, trackId: id });
    void (async () => {
      jobs.start(job.id);
      const forward = (data: unknown): void => {
        const payload = data as { jobId?: string; stage?: string; fraction?: number };
        if (payload?.jobId === job.id) {
          jobs.progress(job.id, payload.stage ?? 'export', payload.fraction ?? 0);
        }
      };
      sidecar.on('progress', forward);
      try {
        await sidecar.request(
          'mix.export',
          {
            tracks,
            outputPath,
            format: request.format ?? 'wav',
            bitDepth: request.bitDepth ?? 24,
            masterGainDb: request.masterGainDb ?? 0,
            normalise: Boolean(request.normalise),
            startSeconds: request.startSeconds ?? null,
            endSeconds: request.endSeconds ?? null,
            jobId: job.id,
          },
          LONG_REQUEST_TIMEOUT_MS,
        );
        jobs.succeed(job.id);
        notify({
          level: 'info',
          title: 'Mix exported',
          message: `Saved to ${outputPath}`,
        });
      } catch (error) {
        jobs.fail(job.id, {
          code: error instanceof SidecarError ? error.code : 'INTERNAL',
          message: (error as Error).message,
        });
      } finally {
        sidecar.off('progress', forward);
      }
    })();

    return { jobId: job.id };
  });

  handle(CHANNELS.tracksRevealInFolder, async (trackId) => {
    const track = await library.getTrack(requireString(trackId, 'trackId'));
    if (!track) throw new IpcError('UNKNOWN_TRACK', 'That track is no longer in the library.');
    shell.showItemInFolder(track.sourcePath);
  });

  // -- jobs ------------------------------------------------------------

  handle(CHANNELS.jobsList, async () => jobs.list());

  handle(CHANNELS.jobsCancel, async (jobId) => {
    const id = requireString(jobId, 'jobId');
    const cancelled = await sidecar.cancel(id);
    jobs.cancel(id);
    return cancelled;
  });

  // -- files -----------------------------------------------------------

  handle(CHANNELS.filesPickAudio, async () => {
    const window = getWindow();
    if (!window) return [];
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose audio files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'wma'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle(CHANNELS.filesPickSaveTarget, async (suggestedName, extensions) => {
    const window = getWindow();
    if (!window) return null;
    const name = requireString(suggestedName, 'suggestedName');
    const exts = requireStringArray(extensions ?? ['wav'], 'extensions');
    const result = await dialog.showSaveDialog(window, {
      title: 'Save as',
      defaultPath: name,
      filters: [{ name: 'Audio', extensions: exts }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  handle(CHANNELS.filesPickDirectory, async () => {
    const window = getWindow();
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(CHANNELS.filesReadPeaks, async (trackId, stemId) => {
    const id = requireString(trackId, 'trackId');
    const state = await library.getState();
    const isStem = typeof stemId === 'string' && stemId.length > 0;
    const { filePath } = resolveMediaPath(
      {
        trackId: id,
        kind: isStem ? 'peaks-stem' : 'peaks-source',
        stemId: isStem ? stemId : null,
      },
      state,
      context.workspaceRoot,
    );
    const buffer = await fs.readFile(filePath);
    // Return a plain ArrayBuffer; a Node Buffer would be structured-cloned
    // as a Uint8Array view over a pooled allocation.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });

  handle(CHANNELS.filesResolveDropped, async (paths) => {
    const candidates = requireStringArray(paths, 'paths');
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const candidate of candidates) {
      if (!hasAudioExtension(candidate) || !(await fileExists(candidate))) {
        rejected.push(candidate);
      } else {
        accepted.push(candidate);
      }
    }
    return { accepted, rejected };
  });

  // -- URL import ------------------------------------------------------

  handle(CHANNELS.youtubeStatus, async () => {
    try {
      await ensureRuntime();
      return await sidecar.request('youtube.available', {}, 30_000);
    } catch {
      return { available: false, allowedHosts: [], maxDurationSeconds: 0 };
    }
  });

  handle(CHANNELS.youtubeDiagnose, async () => {
    await ensureRuntime();
    // Runs yt-dlp twice and may sit on a network timeout, so it gets a
    // ceiling of its own rather than the default request timeout.
    return sidecar.request('youtube.diagnose', {}, 8 * 60_000);
  });

  handle(CHANNELS.youtubeMetadata, async (url) => {
    await ensureRuntime();
    return sidecar.request('youtube.metadata', { url: requireString(url, 'url') }, 120_000);
  });

  handle(CHANNELS.youtubeImport, async (url, rightsConfirmed, folderId) => {
    const link = requireString(url, 'url');
    if (rightsConfirmed !== true) {
      throw new IpcError(
        'RIGHTS_NOT_CONFIRMED',
        'Confirm you have the right to use this audio before downloading it.',
      );
    }
    await ensureRuntime();

    const job = jobs.create({ kind: 'download', label: 'Downloading audio' });
    void (async () => {
      jobs.start(job.id);
      const forward = (data: unknown): void => {
        const payload = data as { jobId?: string; stage?: string; fraction?: number };
        if (payload?.jobId === job.id) {
          jobs.progress(job.id, payload.stage ?? 'download', (payload.fraction ?? 0) * DOWNLOAD_SHARE);
        }
      };
      sidecar.on('progress', forward);
      try {
        const media = await sidecar.request<{ path: string; title: string; sourceUrl: string }>(
          'youtube.download',
          {
            url: link,
            destinationDir: layout.downloadsDir,
            rightsConfirmed: true,
            jobId: job.id,
          },
          LONG_REQUEST_TIMEOUT_MS,
        );
        sidecar.off('progress', forward);
        jobs.relabel(job.id, media.title || 'Imported audio');

        const currentSettings = await settings.get();
        const track = await workspace.importAndSeparate({
          request: {
            path: media.path,
            title: media.title,
            sourceUrl: media.sourceUrl,
            folderId: typeof folderId === 'string' ? folderId : null,
          },
          settings: currentSettings,
          jobId: job.id,
          // The download already spent the first slice of the bar.
          progressFrom: DOWNLOAD_SHARE,
          progressTo: 1,
        });
        // The download is only a staging copy; the workspace holds the
        // canonical source from here on.
        await fs.rm(media.path, { force: true }).catch(() => undefined);
        jobs.succeed(job.id);
        notify({
          level: 'info',
          title: 'Import finished',
          message: `"${track.title}" is ready.`,
        });
      } catch (error) {
        const payload =
          error instanceof SidecarError
            ? error.toPayload()
            : { code: 'INTERNAL', message: (error as Error).message };
        if (payload.code === 'CANCELLED') jobs.cancel(job.id);
        else jobs.fail(job.id, payload);
      } finally {
        sidecar.off('progress', forward);
      }
    })();

    return { track: null, jobId: job.id };
  });

  // -- settings --------------------------------------------------------

  handle(CHANNELS.settingsGet, async () => settings.get());

  handle(CHANNELS.settingsSet, async (patch) => {
    if (!patch || typeof patch !== 'object') {
      throw new IpcError('INVALID_ARGUMENT', 'settings patch must be an object');
    }
    return settings.set(patch as Partial<Settings>);
  });

  handle(CHANNELS.logsReveal, async () => {
    // showItemInFolder highlights the file itself rather than just opening
    // the directory, so the right one is obvious among the rotated copies.
    shell.showItemInFolder(log.filePath);
    return true;
  });

  handle(CHANNELS.logsRead, async () => ({
    path: log.filePath,
    text: log.tail(),
  }));
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}