/**
 * WAV encoding in the renderer.
 *
 * Used for the fast export path: the mix is rendered with an
 * `OfflineAudioContext` and written straight to a WAV here, without a
 * round trip through the Python sidecar. FLAC, MP3 and 32-bit float go
 * through `sipra_core.mixdown` instead.
 */

export type WavBitDepth = 16 | 24 | 32;

export interface WavOptions {
  /** 32 writes IEEE float; 16 and 24 write PCM. */
  bitDepth?: WavBitDepth;
  /**
   * Hard-limit samples to [-1, 1] before quantising. On by default:
   * integer PCM wraps on overflow, turning a hot mix into loud noise.
   */
  clip?: boolean;
}

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;

/**
 * Interleave and encode planar channel data into a RIFF/WAVE file.
 *
 * Channels of unequal length are padded with silence to the longest, so a
 * stem that ends early cannot truncate the whole mix.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: WavOptions = {},
): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav needs at least one channel');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sample rate: ${sampleRate}`);
  }

  const bitDepth = options.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) {
    throw new Error(`Unsupported bit depth: ${bitDepth}`);
  }
  const clip = options.clip ?? true;

  const channelCount = channels.length;
  const frames = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const format = bitDepth === 32 ? FORMAT_IEEE_FLOAT : FORMAT_PCM;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      let sample = channels[channel]?.[frame] ?? 0;
      if (!Number.isFinite(sample)) sample = 0;
      if (clip) sample = Math.min(1, Math.max(-1, sample));

      if (bitDepth === 32) {
        view.setFloat32(offset, sample, true);
      } else if (bitDepth === 16) {
        view.setInt16(offset, toInt(sample, 32767, 32767, -32768), true);
      } else {
        writeInt24(view, offset, toInt(sample, 8388607, 8388607, -8388608));
      }
      offset += bytesPerSample;
    }
  }

  return buffer;
}

/**
 * Quantise a float sample to an integer.
 *
 * Positive and negative full scale use different limits because two's
 * complement is asymmetric: scaling by the positive maximum keeps -1.0
 * from wrapping to +full scale.
 */
function toInt(sample: number, scale: number, max: number, min: number): number {
  const value = Math.round(sample * scale);
  return Math.min(max, Math.max(min, value));
}

function writeInt24(view: DataView, offset: number, value: number): void {
  const unsigned = value < 0 ? value + 0x1000000 : value;
  view.setUint8(offset, unsigned & 0xff);
  view.setUint8(offset + 1, (unsigned >> 8) & 0xff);
  view.setUint8(offset + 2, (unsigned >> 16) & 0xff);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Read back the header of a WAV produced here. Used by tests and imports. */
export function readWavHeader(buffer: ArrayBuffer): {
  format: number;
  channels: number;
  sampleRate: number;
  bitDepth: number;
  dataBytes: number;
  frames: number;
} {
  if (buffer.byteLength < 44) throw new Error('Buffer is too short to be a WAV file');
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitDepth = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const blockAlign = channels * (bitDepth / 8);
  return {
    format,
    channels,
    sampleRate,
    bitDepth,
    dataBytes,
    frames: blockAlign > 0 ? dataBytes / blockAlign : 0,
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}

/** Decode the PCM/float payload back into planar channels. */
export function decodeWav(buffer: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } {
  const header = readWavHeader(buffer);
  const view = new DataView(buffer);
  const channels: Float32Array[] = Array.from(
    { length: header.channels },
    () => new Float32Array(header.frames),
  );

  let offset = 44;
  const bytesPerSample = header.bitDepth / 8;
  for (let frame = 0; frame < header.frames; frame += 1) {
    for (let channel = 0; channel < header.channels; channel += 1) {
      let value: number;
      if (header.bitDepth === 32) {
        value = view.getFloat32(offset, true);
      } else if (header.bitDepth === 16) {
        value = view.getInt16(offset, true) / 32767;
      } else {
        const raw =
          view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
        value = signed / 8388607;
      }
      const target = channels[channel];
      if (target) target[frame] = value;
      offset += bytesPerSample;
    }
  }

  return { channels, sampleRate: header.sampleRate };
}
