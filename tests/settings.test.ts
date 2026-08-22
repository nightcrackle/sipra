import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '@shared/types';

import { normaliseSettings, SettingsService } from '../electron/services/settings';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-settings-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('normaliseSettings', () => {
  it('returns defaults for junk', () => {
    for (const junk of [null, undefined, 42, 'text']) {
      expect(normaliseSettings(junk)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid values', () => {
    const settings = normaliseSettings({
      ...DEFAULT_SETTINGS,
      modelId: 'htdemucs_6s',
      stemPreset: 'six',
      defaultExportFormat: 'flac',
      defaultExportBitDepth: 24,
    });
    expect(settings.modelId).toBe('htdemucs_6s');
    expect(settings.stemPreset).toBe('six');
    expect(settings.defaultExportFormat).toBe('flac');
  });

  it('rejects an invalid enum and falls back to the default', () => {
    expect(normaliseSettings({ stemPreset: 'twelve' }).stemPreset).toBe(
      DEFAULT_SETTINGS.stemPreset,
    );
    expect(normaliseSettings({ defaultExportFormat: 'aiff' }).defaultExportFormat).toBe(
      DEFAULT_SETTINGS.defaultExportFormat,
    );
    expect(normaliseSettings({ theme: 'neon' }).theme).toBe(DEFAULT_SETTINGS.theme);
    expect(normaliseSettings({ meterBallistics: 'vu' }).meterBallistics).toBe(
      DEFAULT_SETTINGS.meterBallistics,
    );
  });

  it('rejects an unsupported bit depth', () => {
    expect(normaliseSettings({ defaultExportBitDepth: 12 }).defaultExportBitDepth).toBe(
      DEFAULT_SETTINGS.defaultExportBitDepth,
    );
  });

  it('rejects a non-string engine or model id', () => {
    expect(normaliseSettings({ engineId: 42 }).engineId).toBe(DEFAULT_SETTINGS.engineId);
    expect(normaliseSettings({ modelId: '' }).modelId).toBe(DEFAULT_SETTINGS.modelId);
  });

  it('allows null for the optional device and workspace', () => {
    expect(normaliseSettings({ device: null }).device).toBeNull();
    expect(normaliseSettings({ device: 'cuda' }).device).toBe('cuda');
    expect(normaliseSettings({ device: 42 }).device).toBeNull();
  });

  it('drops unknown keys from a newer build', () => {
    // Downgrading must not leave the app unable to read its own settings.
    const settings = normaliseSettings({ ...DEFAULT_SETTINGS, futureFeature: true });
    expect('futureFeature' in settings).toBe(false);
  });

  it('fills in keys missing from an older file', () => {
    expect(normaliseSettings({ modelId: 'htdemucs' })).toMatchObject({
      autoAnalyse: DEFAULT_SETTINGS.autoAnalyse,
      theme: DEFAULT_SETTINGS.theme,
    });
  });
});

describe('SettingsService', () => {
  const makeService = (): SettingsService =>
    new SettingsService(path.join(directory, 'settings.json'));

  it('starts from the defaults', async () => {
    expect(await makeService().get()).toEqual(DEFAULT_SETTINGS);
  });

  it('applies and persists a patch', async () => {
    const service = makeService();
    await service.set({ stemPreset: 'six' });
    expect((await service.get()).stemPreset).toBe('six');
    expect((await makeService().get()).stemPreset).toBe('six');
  });

  it('merges rather than replacing', async () => {
    const service = makeService();
    await service.set({ stemPreset: 'six' });
    await service.set({ autoAnalyse: false });
    const settings = await service.get();
    expect(settings.stemPreset).toBe('six');
    expect(settings.autoAnalyse).toBe(false);
  });

  it('validates a patch before saving it', async () => {
    const service = makeService();
    await service.set({ stemPreset: 'nonsense' as never });
    expect((await service.get()).stemPreset).toBe(DEFAULT_SETTINGS.stemPreset);
  });

  it('announces a change', async () => {
    const service = makeService();
    const listener = vi.fn();
    service.on('changed', listener);
    await service.set({ autoAnalyse: false });
    expect(listener).toHaveBeenCalledOnce();
  });
});
