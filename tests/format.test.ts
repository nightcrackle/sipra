import { describe, expect, it } from 'vitest';

import {
  formatBpm,
  formatBytes,
  formatChannels,
  formatConfidence,
  formatDb,
  formatDuration,
  formatEstimate,
  formatKey,
  formatLu,
  formatLufs,
  formatPercent,
  formatRelativeTime,
  formatSampleRate,
  formatTime,
  truncateMiddle,
} from '@shared/format';

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [125, '2:05'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatTime(seconds)).toBe(expected);
  });

  it('adds milliseconds when asked', () => {
    expect(formatTime(65.432, { millis: true })).toBe('1:05.432');
    expect(formatTime(0.5, { millis: true })).toBe('0:00.500');
  });

  it('shows a placeholder rather than NaN for bad input', () => {
    // A lane renders this before its audio has loaded.
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(Number.NaN, { millis: true })).toBe('0:00.000');
  });
});

describe('formatDuration', () => {
  it('formats a length', () => {
    expect(formatDuration(210)).toBe('3:30');
  });

  it('uses a dash for unknown values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatDb', () => {
  it('formats with one decimal by default', () => {
    expect(formatDb(-12.34)).toBe('-12.3 dB');
  });

  it('honours a decimal count', () => {
    expect(formatDb(-12.345, { decimals: 2 })).toBe('-12.35 dB');
  });

  it('adds a plus sign when asked', () => {
    expect(formatDb(3, { sign: true })).toBe('+3.0 dB');
    expect(formatDb(-3, { sign: true })).toBe('-3.0 dB');
  });

  it('renders digital silence as minus infinity', () => {
    expect(formatDb(-Infinity)).toBe('-∞ dB');
  });

  it('uses a dash for unknown values', () => {
    expect(formatDb(null)).toBe('—');
    expect(formatDb(Number.NaN)).toBe('—');
  });
});

describe('loudness formatting', () => {
  it('formats LUFS and LU', () => {
    expect(formatLufs(-9.43)).toBe('-9.4 LUFS');
    expect(formatLu(5.56)).toBe('5.6 LU');
  });

  it('uses a dash for unknown values', () => {
    expect(formatLufs(null)).toBe('—');
    expect(formatLu(Infinity)).toBe('—');
  });
});

describe('formatBpm', () => {
  it('drops a pointless decimal', () => {
    expect(formatBpm(128)).toBe('128');
    expect(formatBpm(127.98)).toBe('128');
  });

  it('keeps a decimal that carries information', () => {
    expect(formatBpm(127.4)).toBe('127.4');
  });

  it('uses a dash for unknown or impossible values', () => {
    expect(formatBpm(null)).toBe('—');
    expect(formatBpm(0)).toBe('—');
    expect(formatBpm(-5)).toBe('—');
  });
});

describe('formatKey', () => {
  it('abbreviates the scale', () => {
    expect(formatKey('A', 'minor')).toBe('A min');
    expect(formatKey('C#', 'major')).toBe('C# maj');
  });

  it('shows the tonic alone when the scale is unknown', () => {
    expect(formatKey('A', null)).toBe('A');
  });

  it('uses a dash when there is no key', () => {
    expect(formatKey(null, 'major')).toBe('—');
  });
});

describe('formatConfidence', () => {
  it.each([
    [0.95, 'high'],
    [0.7, 'high'],
    [0.5, 'fair'],
    [0.4, 'fair'],
    [0.2, 'low'],
    [0, 'low'],
  ])('describes %f as %s', (value, expected) => {
    expect(formatConfidence(value)).toBe(expected);
  });

  it('uses a dash when there is nothing to report', () => {
    expect(formatConfidence(null)).toBe('—');
    expect(formatConfidence(Number.NaN)).toBe('—');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1024 * 1024 * 3.5, '3.5 MB'],
    [1024 * 1024 * 1024 * 2, '2.0 GB'],
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('drops the decimal for large values in a unit', () => {
    expect(formatBytes(1024 * 900)).toBe('900 KB');
  });

  it('uses a dash for unknown values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('format helpers', () => {
  it('formats a sample rate', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(null)).toBe('—');
  });

  it('names channel layouts', () => {
    expect(formatChannels(1)).toBe('Mono');
    expect(formatChannels(2)).toBe('Stereo');
    expect(formatChannels(6)).toBe('6 ch');
    expect(formatChannels(null)).toBe('—');
  });

  it('formats and clamps a percentage', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(5)).toBe('100%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it.each([
    [now - 5_000, 'just now'],
    [now - 5 * 60_000, '5 minutes ago'],
    [now - 60_000, '1 minute ago'],
    [now - 3 * 3_600_000, '3 hours ago'],
    [now - 3_600_000, '1 hour ago'],
    [now - 2 * 86_400_000, '2 days ago'],
  ])('describes a timestamp as %s', (timestamp, expected) => {
    expect(formatRelativeTime(timestamp, now)).toBe(expected);
  });

  it('falls back to a date past a week', () => {
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).toMatch(/\d/);
  });

  it('does not report a future timestamp as negative', () => {
    expect(formatRelativeTime(now + 100_000, now)).toBe('just now');
  });

  it('uses a dash for a bad timestamp', () => {
    expect(formatRelativeTime(Number.NaN, now)).toBe('—');
  });
});

describe('formatEstimate', () => {
  it('hedges deliberately, because it is a guess', () => {
    expect(formatEstimate(30)).toBe('under a minute');
    expect(formatEstimate(120)).toBe('about 2 minutes');
    expect(formatEstimate(60)).toBe('about 1 minute');
    expect(formatEstimate(7200)).toBe('about 2 hours');
    expect(formatEstimate(0)).toBe('a moment');
  });
});

describe('truncateMiddle', () => {
  it('leaves a short string alone', () => {
    expect(truncateMiddle('short.wav', 40)).toBe('short.wav');
  });

  it('elides the middle and keeps the extension visible', () => {
    const result = truncateMiddle(`${'a'.repeat(60)}.wav`, 20);
    expect(result).toHaveLength(20);
    expect(result).toContain('…');
    expect(result.endsWith('wav')).toBe(true);
  });
});
