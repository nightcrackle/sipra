/**
 * Reading and drawing waveform peak envelopes.
 *
 * The binary layout is defined in `python/sipra_core/waveform.py`; this is
 * the reader. Keep the two in step — a test checks the header constants
 * match.
 */

export const PEAKS_MAGIC = 'SPKS1';
export const PEAKS_VERSION = 1;
export const PEAKS_HEADER_SIZE = 32;
const INT16_SCALE = 32767;

export interface PeakData {
  sampleRate: number;
  samplesPerBucket: number;
  sourceChannels: number;
  durationSeconds: number;
  bucketCount: number;
  minima: Float32Array;
  maxima: Float32Array;
}

export class PeakDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeakDecodeError';
  }
}

export function decodePeaks(buffer: ArrayBuffer | Uint8Array): PeakData {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < PEAKS_HEADER_SIZE) {
    throw new PeakDecodeError('Peak payload is shorter than its header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 5));
  if (magic !== PEAKS_MAGIC) {
    throw new PeakDecodeError('Not a Sipra peak file');
  }
  const version = view.getUint8(5);
  if (version !== PEAKS_VERSION) {
    throw new PeakDecodeError(`Unsupported peak file version ${version}`);
  }

  const sampleRate = view.getUint32(8, true);
  const samplesPerBucket = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const sourceChannels = view.getUint32(20, true);
  const durationSeconds = view.getFloat64(24, true);

  const expected = bucketCount * 2 * 2;
  if (bytes.byteLength - PEAKS_HEADER_SIZE < expected) {
    throw new PeakDecodeError('Peak payload is truncated');
  }

  const minima = new Float32Array(bucketCount);
  const maxima = new Float32Array(bucketCount);
  let offset = PEAKS_HEADER_SIZE;
  for (let i = 0; i < bucketCount; i += 1) {
    minima[i] = view.getInt16(offset, true) / INT16_SCALE;
    maxima[i] = view.getInt16(offset + 2, true) / INT16_SCALE;
    offset += 4;
  }

  return {
    sampleRate,
    samplesPerBucket,
    sourceChannels,
    durationSeconds,
    bucketCount,
    minima,
    maxima,
  };
}

export interface Envelope {
  min: Float32Array;
  max: Float32Array;
  columns: number;
}

/**
 * Reduce a peak envelope to exactly `columns` min/max pairs covering the
 * time window `[startSeconds, endSeconds)`.
 *
 * Zooming in past one bucket per column repeats buckets rather than
 * interpolating, which keeps the drawn shape truthful — an interpolated
 * waveform invents amplitudes the audio never had.
 */
export function decimatePeaks(
  peaks: PeakData,
  startSeconds: number,
  endSeconds: number,
  columns: number,
): Envelope {
  const width = Math.max(1, Math.floor(columns));
  const min = new Float32Array(width);
  const max = new Float32Array(width);

  if (peaks.bucketCount === 0 || !(endSeconds > startSeconds)) {
    return { min, max, columns: width };
  }

  const bucketsPerSecond = peaks.sampleRate / peaks.samplesPerBucket;
  const startBucket = Math.max(0, startSeconds * bucketsPerSecond);
  const endBucket = Math.min(peaks.bucketCount, endSeconds * bucketsPerSecond);
  const span = endBucket - startBucket;
  if (!(span > 0)) return { min, max, columns: width };

  const perColumn = span / width;

  for (let column = 0; column < width; column += 1) {
    const from = startBucket + column * perColumn;
    const to = from + perColumn;
    let lo = Math.floor(from);
    let hi = Math.ceil(to);
    if (hi <= lo) hi = lo + 1;
    if (lo < 0) lo = 0;
    if (hi > peaks.bucketCount) hi = peaks.bucketCount;
    if (lo >= peaks.bucketCount) {
      lo = peaks.bucketCount - 1;
      hi = peaks.bucketCount;
    }

    let lowest = Infinity;
    let highest = -Infinity;
    for (let bucket = lo; bucket < hi; bucket += 1) {
      const a = peaks.minima[bucket] ?? 0;
      const b = peaks.maxima[bucket] ?? 0;
      if (a < lowest) lowest = a;
      if (b > highest) highest = b;
    }
    min[column] = Number.isFinite(lowest) ? lowest : 0;
    max[column] = Number.isFinite(highest) ? highest : 0;
  }

  return { min, max, columns: width };
}

/**
 * Build a peak envelope straight from decoded audio.
 *
 * Used when a lane is zoomed in far enough that the precomputed envelope
 * runs out of resolution.
 */
export function peaksFromChannels(
  channels: readonly Float32Array[],
  sampleRate: number,
  startSample: number,
  endSample: number,
  columns: number,
): Envelope {
  const width = Math.max(1, Math.floor(columns));
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  const first = channels[0];
  if (!first || channels.length === 0) return { min, max, columns: width };

  const from = Math.max(0, Math.floor(startSample));
  const to = Math.min(first.length, Math.ceil(endSample));
  const span = to - from;
  if (span <= 0) return { min, max, columns: width };

  const perColumn = span / width;
  const channelCount = channels.length;

  for (let column = 0; column < width; column += 1) {
    const lo = from + Math.floor(column * perColumn);
    let hi = from + Math.floor((column + 1) * perColumn);
    if (hi <= lo) hi = lo + 1;
    if (hi > to) hi = to;

    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = lo; index < hi; index += 1) {
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        sum += channels[channel]?.[index] ?? 0;
      }
      const value = sum / channelCount;
      if (value < lowest) lowest = value;
      if (value > highest) highest = value;
    }
    min[column] = Number.isFinite(lowest) ? lowest : 0;
    max[column] = Number.isFinite(highest) ? highest : 0;
  }

  return { min, max, columns: width };
}

/** Sample index at a given time, clamped to the buffer. */
export function timeToSample(seconds: number, sampleRate: number, totalSamples: number): number {
  return Math.min(totalSamples, Math.max(0, Math.round(seconds * sampleRate)));
}
