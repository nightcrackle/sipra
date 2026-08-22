import { describe, expect, it } from 'vitest';

import {
  decimatePeaks,
  decodePeaks,
  PEAKS_HEADER_SIZE,
  PEAKS_MAGIC,
  PEAKS_VERSION,
  PeakDecodeError,
  type PeakData,
  peaksFromChannels,
  timeToSample,
} from '@shared/peaks';

/** Build a `.speaks` payload exactly as the Python writer would. */
function buildPayload(options: {
  sampleRate?: number;
  samplesPerBucket?: number;
  channels?: number;
  duration?: number;
  pairs?: Array<[number, number]>;
  magic?: string;
  version?: number;
}): ArrayBuffer {
  const pairs = options.pairs ?? [];
  const buffer = new ArrayBuffer(PEAKS_HEADER_SIZE + pairs.length * 4);
  const view = new DataView(buffer);
  const magic = options.magic ?? PEAKS_MAGIC;
  for (let index = 0; index < 5; index += 1) view.setUint8(index, magic.charCodeAt(index));
  view.setUint8(5, options.version ?? PEAKS_VERSION);
  view.setUint16(6, 0, true);
  view.setUint32(8, options.sampleRate ?? 44100, true);
  view.setUint32(12, options.samplesPerBucket ?? 256, true);
  view.setUint32(16, pairs.length, true);
  view.setUint32(20, options.channels ?? 2, true);
  view.setFloat64(24, options.duration ?? 1, true);

  let offset = PEAKS_HEADER_SIZE;
  for (const [low, high] of pairs) {
    view.setInt16(offset, Math.round(low * 32767), true);
    view.setInt16(offset + 2, Math.round(high * 32767), true);
    offset += 4;
  }
  return buffer;
}

function makePeaks(pairs: Array<[number, number]>, sampleRate = 44100, bucket = 256): PeakData {
  return decodePeaks(
    buildPayload({
      pairs,
      sampleRate,
      samplesPerBucket: bucket,
      duration: (pairs.length * bucket) / sampleRate,
    }),
  );
}

describe('decodePeaks', () => {
  it('reads the header fields', () => {
    const peaks = decodePeaks(
      buildPayload({
        sampleRate: 48000,
        samplesPerBucket: 512,
        channels: 1,
        duration: 12.5,
        pairs: [[-0.5, 0.5]],
      }),
    );
    expect(peaks.sampleRate).toBe(48000);
    expect(peaks.samplesPerBucket).toBe(512);
    expect(peaks.sourceChannels).toBe(1);
    expect(peaks.durationSeconds).toBeCloseTo(12.5, 6);
    expect(peaks.bucketCount).toBe(1);
  });

  it('scales samples back into the -1 to 1 range', () => {
    const peaks = decodePeaks(buildPayload({ pairs: [[-1, 1], [-0.25, 0.75]] }));
    expect(peaks.minima[0]).toBeCloseTo(-1, 4);
    expect(peaks.maxima[0]).toBeCloseTo(1, 4);
    expect(peaks.minima[1]).toBeCloseTo(-0.25, 4);
    expect(peaks.maxima[1]).toBeCloseTo(0.75, 4);
  });

  it('accepts a Uint8Array as well as an ArrayBuffer', () => {
    const payload = buildPayload({ pairs: [[-0.5, 0.5]] });
    expect(decodePeaks(new Uint8Array(payload)).bucketCount).toBe(1);
  });

  it('rejects a payload shorter than the header', () => {
    expect(() => decodePeaks(new ArrayBuffer(8))).toThrow(PeakDecodeError);
  });

  it('rejects a foreign magic number', () => {
    expect(() => decodePeaks(buildPayload({ magic: 'XXXXX', pairs: [] }))).toThrow(
      /Not a Sipra peak file/,
    );
  });

  it('rejects an unknown version', () => {
    expect(() => decodePeaks(buildPayload({ version: 99, pairs: [] }))).toThrow(/version 99/);
  });

  it('rejects a truncated body', () => {
    const full = buildPayload({ pairs: [[-1, 1], [-1, 1]] });
    expect(() => decodePeaks(full.slice(0, full.byteLength - 4))).toThrow(/truncated/);
  });

  it('handles an empty envelope', () => {
    const peaks = decodePeaks(buildPayload({ pairs: [], duration: 0 }));
    expect(peaks.bucketCount).toBe(0);
  });
});

describe('decimatePeaks', () => {
  const peaks = makePeaks(
    Array.from({ length: 100 }, (_value, index) => [-index / 100, index / 100] as [number, number]),
  );

  it('returns exactly the requested number of columns', () => {
    expect(decimatePeaks(peaks, 0, peaks.durationSeconds, 37).columns).toBe(37);
    expect(decimatePeaks(peaks, 0, peaks.durationSeconds, 37).max).toHaveLength(37);
  });

  it('preserves the loudest value in each column', () => {
    // Downsampling must never make a transient disappear.
    const envelope = decimatePeaks(peaks, 0, peaks.durationSeconds, 10);
    expect(envelope.max[9]).toBeCloseTo(0.99, 2);
    expect(envelope.min[9]).toBeCloseTo(-0.99, 2);
  });

  it('is monotonic for a ramp', () => {
    const envelope = decimatePeaks(peaks, 0, peaks.durationSeconds, 20);
    for (let index = 1; index < 20; index += 1) {
      expect(envelope.max[index]!).toBeGreaterThanOrEqual(envelope.max[index - 1]!);
    }
  });

  it('windows to a time range', () => {
    const half = peaks.durationSeconds / 2;
    const envelope = decimatePeaks(peaks, half, peaks.durationSeconds, 5);
    // The second half of a 0-to-1 ramp starts at about 0.5.
    expect(envelope.max[0]!).toBeGreaterThan(0.45);
  });

  it('repeats buckets rather than interpolating when zoomed in past them', () => {
    // Interpolating would draw amplitudes the audio never contained.
    const envelope = decimatePeaks(peaks, 0, peaks.samplesPerBucket / peaks.sampleRate, 8);
    expect(new Set(Array.from(envelope.max)).size).toBe(1);
  });

  it('clamps a range that runs past the end', () => {
    const envelope = decimatePeaks(peaks, 0, peaks.durationSeconds * 4, 16);
    expect(envelope.max.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('returns silence for an inverted range', () => {
    const envelope = decimatePeaks(peaks, 5, 1, 8);
    expect(Array.from(envelope.max)).toEqual(Array.from({ length: 8 }, () => 0));
  });

  it('returns silence for an empty envelope', () => {
    const envelope = decimatePeaks(makePeaks([]), 0, 1, 4);
    expect(Array.from(envelope.min)).toEqual([0, 0, 0, 0]);
  });

  it('never produces fewer than one column', () => {
    expect(decimatePeaks(peaks, 0, 1, 0).columns).toBe(1);
    expect(decimatePeaks(peaks, 0, 1, -5).columns).toBe(1);
  });

  it('never returns a NaN', () => {
    const envelope = decimatePeaks(peaks, -10, 1e9, 64);
    expect(Array.from(envelope.max).every((value) => !Number.isNaN(value))).toBe(true);
  });
});

describe('peaksFromChannels', () => {
  const left = Float32Array.from({ length: 1000 }, (_value, index) =>
    Math.sin((index / 1000) * Math.PI * 2),
  );

  it('finds the extremes of a sine', () => {
    const envelope = peaksFromChannels([left], 44100, 0, 1000, 10);
    expect(Math.max(...Array.from(envelope.max))).toBeCloseTo(1, 2);
    expect(Math.min(...Array.from(envelope.min))).toBeCloseTo(-1, 2);
  });

  it('averages channels', () => {
    const silence = new Float32Array(1000);
    const envelope = peaksFromChannels([left, silence], 44100, 0, 1000, 4);
    expect(Math.max(...Array.from(envelope.max))).toBeCloseTo(0.5, 2);
  });

  it('returns silence when given no channels', () => {
    expect(Array.from(peaksFromChannels([], 44100, 0, 100, 3).max)).toEqual([0, 0, 0]);
  });

  it('clamps a range beyond the buffer', () => {
    const envelope = peaksFromChannels([left], 44100, -50, 99999, 8);
    expect(envelope.columns).toBe(8);
    expect(Array.from(envelope.max).every(Number.isFinite)).toBe(true);
  });

  it('returns silence for an empty range', () => {
    expect(Array.from(peaksFromChannels([left], 44100, 500, 500, 3).max)).toEqual([0, 0, 0]);
  });
});

describe('timeToSample', () => {
  it('converts seconds to a sample index', () => {
    expect(timeToSample(1, 44100, 88200)).toBe(44100);
  });

  it('clamps to the buffer', () => {
    expect(timeToSample(-5, 44100, 88200)).toBe(0);
    expect(timeToSample(100, 44100, 88200)).toBe(88200);
  });
});
