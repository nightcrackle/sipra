/**
 * User settings, stored as JSON next to the library.
 *
 * Unknown keys from a newer build are dropped and missing keys fall back
 * to their defaults, so downgrading Sipra never leaves the app unable to
 * read its own settings file.
 */

import { EventEmitter } from 'node:events';

import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';
import { JsonStore } from './jsonStore';

const EXPORT_FORMATS = new Set(['wav', 'flac', 'mp3']);
const BIT_DEPTHS = new Set([16, 24, 32]);
const STEM_PRESETS = new Set(['four', 'six']);
const THEMES = new Set(['dark', 'light', 'system']);
const BALLISTICS = new Set(['peak', 'rms']);

export function normaliseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const candidate = raw as Partial<Settings>;

  const pick = <K extends keyof Settings>(
    key: K,
    valid: (value: unknown) => boolean,
  ): Settings[K] => (valid(candidate[key]) ? (candidate[key] as Settings[K]) : DEFAULT_SETTINGS[key]);

  return {
    engineId: pick('engineId', (v) => typeof v === 'string' && v.length > 0),
    modelId: pick('modelId', (v) => typeof v === 'string' && v.length > 0),
    device: typeof candidate.device === 'string' ? candidate.device : null,
    stemPreset: pick('stemPreset', (v) => typeof v === 'string' && STEM_PRESETS.has(v)),
    defaultExportFormat: pick(
      'defaultExportFormat',
      (v) => typeof v === 'string' && EXPORT_FORMATS.has(v),
    ),
    defaultExportBitDepth: pick(
      'defaultExportBitDepth',
      (v) => typeof v === 'number' && BIT_DEPTHS.has(v),
    ),
    normaliseExports: pick('normaliseExports', (v) => typeof v === 'boolean'),
    autoAnalyse: pick('autoAnalyse', (v) => typeof v === 'boolean'),
    workspaceDir: typeof candidate.workspaceDir === 'string' ? candidate.workspaceDir : null,
    acknowledgedRightsNotice: pick('acknowledgedRightsNotice', (v) => typeof v === 'boolean'),
    theme: pick('theme', (v) => typeof v === 'string' && THEMES.has(v)),
    meterBallistics: pick('meterBallistics', (v) => typeof v === 'string' && BALLISTICS.has(v)),
  };
}

export class SettingsService extends EventEmitter {
  private readonly store: JsonStore<Settings>;

  constructor(filePath: string) {
    super();
    this.store = new JsonStore<Settings>({
      filePath,
      defaults: () => ({ ...DEFAULT_SETTINGS }),
      normalise: normaliseSettings,
    });
  }

  async get(): Promise<Settings> {
    return this.store.read();
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next = normaliseSettings({ ...current, ...patch });
    const saved = await this.store.write(next);
    this.emit('changed', saved);
    return saved;
  }
}
