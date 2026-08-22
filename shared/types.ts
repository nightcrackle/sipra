/** Types shared between the Electron main process and the renderer. */

import type { StemId } from './stems';

// ---------------------------------------------------------------------------
// Audio core
// ---------------------------------------------------------------------------

export interface TrackAnalysis {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  bpm: number | null;
  bpmConfidence: number;
  key: string | null;
  scale: 'major' | 'minor' | null;
  keyLabel: string;
  keyConfidence: number;
  camelot: string | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  samplePeakDb: number | null;
  truePeakDb: number | null;
  rmsDb: number | null;
  crestFactorDb: number | null;
  beatTimes?: number[];
  warnings?: string[];
}

export interface StemAsset {
  id: StemId;
  audioPath: string;
  peaksPath: string;
  samplePeakDb: number | null;
  rmsDb: number | null;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  stems: StemId[];
  description: string;
  experimental: boolean;
  relativeCost: number;
}

export interface EngineDescriptor {
  id: string;
  label: string;
  available: boolean;
  unavailableReason: string | null;
  devices: string[];
  models: ModelDescriptor[];
}

export interface Capabilities {
  version: string;
  protocolVersion: number;
  python: string;
  engines: EngineDescriptor[];
  stems: Array<{
    id: StemId;
    label: string;
    color: string;
    order: number;
    experimental: boolean;
    note: string;
  }>;
  supportedExtensions: string[];
  ffmpeg: string | null;
  ytdlp: { available: boolean; path: string | null; allowedHosts: string[] };
  torch: { version: string; cuda: boolean; cudaDevice: string | null } | null;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
  order: number;
}

export interface Track {
  id: string;
  title: string;
  artist: string | null;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  trackDir: string;
  sourcePath: string;
  sourcePeaksPath: string;
  originalFileName: string;
  sourceUrl: string | null;
  fingerprint: string | null;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  engineId: string;
  modelId: string;
  device: string;
  stems: StemAsset[];
  analysis: TrackAnalysis | null;
  tags: string[];
  notes: string;
  /** Epoch millis when moved to trash, or null while the track is live. */
  deletedAt: number | null;
  warnings: string[];
}

export const LIBRARY_SCHEMA_VERSION = 1;

export interface LibraryState {
  schemaVersion: number;
  tracks: Track[];
  folders: Folder[];
}

export type TrackSortKey = 'recent' | 'title' | 'duration' | 'bpm' | 'loudness';

export interface LibraryQuery {
  text?: string;
  folderId?: string | null;
  /** 'live' hides trashed tracks, 'trash' shows only trashed ones. */
  scope?: 'live' | 'trash';
  sort?: TrackSortKey;
  descending?: boolean;
  stems?: StemId[];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobKind = 'separate' | 'analyze' | 'download' | 'export' | 'peaks';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobProgress {
  stage: string;
  fraction: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  progress: JobProgress;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: SipraErrorPayload | null;
  trackId: string | null;
}

export interface SipraErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime bootstrap
// ---------------------------------------------------------------------------

export type RuntimeStage =
  | 'idle'
  | 'checking'
  | 'downloading-python'
  | 'creating-environment'
  | 'installing-packages'
  | 'verifying'
  | 'ready'
  | 'failed';

export interface RuntimeStatus {
  stage: RuntimeStage;
  message: string;
  fraction: number;
  pythonPath: string | null;
  error: SipraErrorPayload | null;
  /** True once the sidecar has answered a capabilities request. */
  sidecarReady: boolean;
  capabilities: Capabilities | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  engineId: string;
  modelId: string;
  device: string | null;
  stemPreset: 'four' | 'six';
  defaultExportFormat: 'wav' | 'flac' | 'mp3';
  defaultExportBitDepth: 16 | 24 | 32;
  normaliseExports: boolean;
  autoAnalyse: boolean;
  workspaceDir: string | null;
  acknowledgedRightsNotice: boolean;
  theme: 'dark' | 'light' | 'system';
  meterBallistics: 'peak' | 'rms';
}

export const DEFAULT_SETTINGS: Settings = {
  engineId: 'demucs',
  modelId: 'htdemucs',
  device: null,
  stemPreset: 'four',
  defaultExportFormat: 'wav',
  defaultExportBitDepth: 24,
  normaliseExports: false,
  autoAnalyse: true,
  workspaceDir: null,
  acknowledgedRightsNotice: false,
  theme: 'dark',
  meterBallistics: 'peak',
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface SeparateRequest {
  path: string;
  title?: string;
  engineId?: string;
  modelId?: string;
  stems?: StemId[];
  device?: string | null;
  analyse?: boolean;
  folderId?: string | null;
  sourceUrl?: string | null;
}

export interface ExportMixRequest {
  trackId: string;
  outputPath: string;
  lanes: Array<{ stemId: StemId; gainDb: number; muted: boolean; solo: boolean }>;
  format: 'wav' | 'flac' | 'mp3';
  bitDepth: 16 | 24 | 32;
  masterGainDb: number;
  normalise: boolean;
  startSeconds?: number | null;
  endSeconds?: number | null;
}
