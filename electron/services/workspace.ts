/**
 * Turning a dropped file into a library track.
 *
 * Owns the workspace layout and the import pipeline: validate, allocate a
 * per-track directory, run separation in the sidecar, then write a track
 * record. If separation fails, the half-built directory is removed so the
 * workspace does not accumulate debris from every failed attempt.
 *
 * Layout under the workspace directory::
 *
 *     library.json
 *     settings.json
 *     tracks/<title>-<shortid>/
 *         source.wav
 *         stems/<stem>.wav
 *         peaks/<name>.speaks
 *     downloads/            temporary landing area for URL imports
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { baseNameOf, stripExtension, trackDirName } from '../../shared/paths';
import { FOUR_STEM_SET, SIX_STEM_SET, type StemId } from '../../shared/stems';
import type {
  SeparateRequest,
  Settings,
  StemAsset,
  Track,
  TrackAnalysis,
} from '../../shared/types';
import type { JobRegistry } from './jobs';
import type { LibraryService } from './library';
import { LONG_REQUEST_TIMEOUT_MS, type Sidecar, SidecarError } from './sidecar';

export interface WorkspaceLayout {
  root: string;
  tracksDir: string;
  downloadsDir: string;
  libraryFile: string;
  settingsFile: string;
}

export function workspaceLayout(root: string): WorkspaceLayout {
  return {
    root,
    tracksDir: path.join(root, 'tracks'),
    downloadsDir: path.join(root, 'downloads'),
    libraryFile: path.join(root, 'library.json'),
    settingsFile: path.join(root, 'settings.json'),
  };
}

export async function ensureWorkspace(layout: WorkspaceLayout): Promise<void> {
  await fs.mkdir(layout.tracksDir, { recursive: true });
  await fs.mkdir(layout.downloadsDir, { recursive: true });
}

/** Stem set for a preset, given what the chosen model can actually do. */
export function stemsForPreset(
  preset: Settings['stemPreset'],
  modelStems: readonly StemId[],
): StemId[] {
  const wanted = preset === 'six' ? SIX_STEM_SET : FOUR_STEM_SET;
  const available = new Set(modelStems);
  const matched = wanted.filter((stem) => available.has(stem));
  // A model that has none of the preset's stems still has to return
  // something, so fall back to everything it does offer.
  return matched.length > 0 ? matched : [...modelStems];
}

/** Raw separation payload from the sidecar. */
interface SeparationPayload {
  trackDir: string;
  sourcePath: string;
  sourcePeaksPath: string;
  sampleRate: number;
  durationSeconds: number;
  channels: number;
  engineId: string;
  modelId: string;
  device: string;
  stems: Array<{
    id: StemId;
    audioPath: string;
    peaksPath: string;
    samplePeakDb: number | null;
    rmsDb: number | null;
  }>;
  analysis: TrackAnalysis | null;
  warnings: string[];
}

export interface ImportOptions {
  request: SeparateRequest;
  settings: Settings;
  jobId: string;
  /**
   * The slice of the job's bar this separation owns.
   *
   * A file dropped in owns all of it. A YouTube import spends the first
   * part of the bar downloading, so its separation starts partway along —
   * without this the separation reported 0-100% into a bar already at 30%,
   * and since the bar never moves backwards it sat motionless at 30% until
   * separation passed a third of the way through. That is the same
   * "nothing is happening" symptom as a real stall.
   */
  progressFrom?: number;
  progressTo?: number;
}

/**
 * How much of a YouTube import's bar the download owns.
 *
 * Both the download's own progress and the separation that follows it are
 * scaled against this one number, so the two halves cannot disagree about
 * where the handover is.
 */
export const DOWNLOAD_SHARE = 0.3;

/**
 * Map a stage's own 0-1 fraction onto the slice of the bar it owns.
 *
 * A job can be made of more than one sidecar call — a YouTube import is a
 * download followed by a separation — and each call reports 0 to 1 for
 * itself. Without this the second call reported 0% into a bar the first
 * had already advanced, and because the bar never moves backwards it stood
 * still until the second call overtook it. Standing still is precisely the
 * symptom of the fault this is meant to make visible.
 */
export function scaleProgress(fraction: number | undefined, from: number, to: number): number {
  const value = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction as number)) : 0;
  return from + (to - from) * value;
}

export class WorkspaceService {
  constructor(
    private readonly layout: WorkspaceLayout,
    private readonly sidecar: Sidecar,
    private readonly library: LibraryService,
    private readonly jobs: JobRegistry,
  ) {}

  get paths(): WorkspaceLayout {
    return this.layout;
  }

  /** Allocate a unique directory for a track. */
  async allocateTrackDir(title: string, trackId: string): Promise<string> {
    const base = trackDirName(title, trackId);
    let candidate = path.join(this.layout.tracksDir, base);
    let counter = 2;
    // A collision needs a real accident (same title, same id prefix), but
    // silently writing into an existing track's directory would be worse
    // than an ugly suffix.
    while (await exists(candidate)) {
      candidate = path.join(this.layout.tracksDir, `${base}-${counter}`);
      counter += 1;
      if (counter > 500) {
        candidate = path.join(this.layout.tracksDir, `${base}-${randomUUID().slice(0, 8)}`);
        break;
      }
    }
    await fs.mkdir(candidate, { recursive: true });
    return candidate;
  }

  /**
   * Validate, separate and file a new track.
   *
   * Progress is forwarded to the job registry as it arrives from the
   * sidecar; the returned promise settles when the track is in the
   * library.
   */
  async importAndSeparate(options: ImportOptions): Promise<Track> {
    const { request, settings, jobId, progressFrom = 0, progressTo = 1 } = options;
    const trackId = randomUUID();
    const fileName = baseNameOf(request.path);
    const title = (request.title ?? stripExtension(fileName)).trim() || 'Untitled';

    this.jobs.start(jobId);

    const validated = await this.sidecar.request<{ fingerprint?: string }>(
      'ingest.validate',
      { path: request.path },
      60_000,
    );

    const trackDir = await this.allocateTrackDir(title, trackId);

    const unsubscribe = this.subscribeProgress(jobId, progressFrom, progressTo);
    let payload: SeparationPayload;
    try {
      payload = await this.sidecar.request<SeparationPayload>(
        'separate',
        {
          path: request.path,
          outputDir: trackDir,
          engine: request.engineId ?? settings.engineId,
          model: request.modelId ?? settings.modelId,
          stems: request.stems ?? null,
          device: request.device ?? settings.device,
          analyse: request.analyse ?? settings.autoAnalyse,
          jobId,
        },
        LONG_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      // Nothing usable was produced, so leave no half-built directory.
      await fs.rm(trackDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      unsubscribe();
    }

    const stems: StemAsset[] = payload.stems.map((stem) => ({
      id: stem.id,
      audioPath: stem.audioPath,
      peaksPath: stem.peaksPath,
      samplePeakDb: stem.samplePeakDb,
      rmsDb: stem.rmsDb,
    }));

    const now = Date.now();
    const track: Track = {
      id: trackId,
      title,
      artist: null,
      createdAt: now,
      updatedAt: now,
      folderId: request.folderId ?? null,
      trackDir: payload.trackDir,
      sourcePath: payload.sourcePath,
      sourcePeaksPath: payload.sourcePeaksPath,
      originalFileName: fileName,
      sourceUrl: request.sourceUrl ?? null,
      fingerprint: validated?.fingerprint ?? null,
      durationSeconds: payload.durationSeconds,
      sampleRate: payload.sampleRate,
      channels: payload.channels,
      engineId: payload.engineId,
      modelId: payload.modelId,
      device: payload.device,
      stems,
      analysis: payload.analysis,
      tags: [],
      notes: '',
      deletedAt: null,
      warnings: payload.warnings ?? [],
    };

    await this.library.addTrack(track);
    return track;
  }

  /** Re-run analysis on a track already in the library. */
  async reanalyse(trackId: string, jobId: string): Promise<TrackAnalysis> {
    const track = await this.library.getTrack(trackId);
    if (!track) throw new SidecarError({ code: 'UNKNOWN_TRACK', message: 'Track not found' });

    this.jobs.start(jobId);
    const unsubscribe = this.subscribeProgress(jobId);
    try {
      const analysis = await this.sidecar.request<TrackAnalysis>(
        'analyze',
        { path: track.sourcePath, jobId },
        LONG_REQUEST_TIMEOUT_MS,
      );
      await this.library.patchTrack(trackId, { analysis });
      return analysis;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Bridge sidecar progress events to one job.
   *
   * Events carry the job id, so several jobs can be in flight without
   * their progress crossing over.
   */
  private subscribeProgress(jobId: string, from = 0, to = 1): () => void {
    const handler = (data: unknown): void => {
      const payload = data as { jobId?: string; stage?: string; fraction?: number } | undefined;
      if (!payload || payload.jobId !== jobId) return;
      this.jobs.progress(jobId, payload.stage ?? 'working', scaleProgress(payload.fraction, from, to));
    };
    this.sidecar.on('progress', handler);
    return () => {
      this.sidecar.off('progress', handler);
    };
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
