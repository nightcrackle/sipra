import { describe, expect, it } from 'vitest';

import { decodeWav, encodeWav, readWavHeader } from '@shared/wav';

const sine = (length: number, cycles = 4): Float32Array =>
  Float32Array.from({ length }, (_value, index) =>
    Math.sin((index / length) * Math.PI * 2 * cycles),
  );

describe('encodeWav', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const header = readWavHeader(encodeWav([sine(100)], 44100));
    expect(header.channels).toBe(1);
    expect(header.sampleRate).toBe(44100);
    expect(header.bitDepth).toBe(16);
    expect(header.frames).toBe(100);
  });

  it('marks 16- and 24-bit output as PCM and 32-bit as IEEE float', () => {
    expect(readWavHeader(encodeWav([sine(10)], 44100, { bitDepth: 16 })).format).toBe(1);
    expect(readWavHeader(encodeWav([sine(10)], 44100, { bitDepth: 24 })).format).toBe(1);
    expect(readWavHeader(encodeWav([sine(10)], 44100, { bitDepth: 32 })).format).toBe(3);
  });

  it('sizes the buffer correctly for each depth', () => {
    expect(encodeWav([sine(100)], 44100, { bitDepth: 16 }).byteLength).toBe(44 + 200);
    expect(encodeWav([sine(100)], 44100, { bitDepth: 24 }).byteLength).toBe(44 + 300);
    expect(encodeWav([sine(100)], 44100, { bitDepth: 32 }).byteLength).toBe(44 + 400);
  });

  it('interleaves channels', () => {
    const left = Float32Array.from([1, 1, 1]);
    const right = Float32Array.from([-1, -1, -1]);
    const decoded = decodeWav(encodeWav([left, right], 44100, { bitDepth: 32 }));
    expect(Array.from(decoded.channels[0]!)).toEqual([1, 1, 1]);
    expect(Array.from(decoded.channels[1]!)).toEqual([-1, -1, -1]);
  });

  it('pads a short channel with silence rather than truncating the mix', () => {
    const decoded = decodeWav(
      encodeWav([Float32Array.from([0.5, 0.5, 0.5]), Float32Array.from([0.5])], 44100, {
        bitDepth: 32,
      }),
    );
    expect(decoded.channels[0]).toHaveLength(3);
    expect(decoded.channels[1]![2]).toBe(0);
  });

  it.each([16, 24, 32] as const)('round-trips a signal at %d-bit', (bitDepth) => {
    const original = sine(512);
    const decoded = decodeWav(encodeWav([original], 48000, { bitDepth }));
    // 16-bit quantisation is about 3e-5; give each depth its own tolerance.
    const tolerance = bitDepth === 16 ? 1e-4 : bitDepth === 24 ? 1e-6 : 1e-7;
    for (let index = 0; index < original.length; index += 1) {
      expect(decoded.channels[0]![index]).toBeCloseTo(original[index]!, -Math.log10(tolerance));
    }
  });

  it('clips rather than wrapping on integer output', () => {
    // Wrapping would turn a hot mix into loud digital noise.
    const hot = Float32Array.from([2.5, -3, 1.5, -1.5]);
    const decoded = decodeWav(encodeWav([hot], 44100, { bitDepth: 16 }));
    for (const value of decoded.channels[0]!) {
      expect(Math.abs(value)).toBeLessThanOrEqual(1.0001);
    }
    expect(decoded.channels[0]![0]).toBeCloseTo(1, 3);
    expect(decoded.channels[0]![1]).toBeCloseTo(-1, 3);
  });

  it('keeps values above full scale when clipping is turned off for float output', () => {
    const hot = Float32Array.from([2.5]);
    const decoded = decodeWav(encodeWav([hot], 44100, { bitDepth: 32, clip: false }));
    expect(decoded.channels[0]![0]).toBeCloseTo(2.5, 5);
  });

  it('does not wrap negative full scale to positive', () => {
    // Scaling -1.0 by 32768 and clamping to int16 is the classic bug here.
    const decoded = decodeWav(encodeWav([Float32Array.from([-1])], 44100, { bitDepth: 16 }));
    expect(decoded.channels[0]![0]).toBeLessThan(0);
  });

  it('writes silence for non-finite samples instead of garbage', () => {
    const nasty = Float32Array.from([Number.NaN, Infinity, -Infinity]);
    const decoded = decodeWav(encodeWav([nasty], 44100, { bitDepth: 32 }));
    expect(Array.from(decoded.channels[0]!)).toEqual([0, 0, 0]);
  });

  it('handles a zero-length channel', () => {
    const header = readWavHeader(encodeWav([new Float32Array(0)], 44100));
    expect(header.frames).toBe(0);
    expect(header.dataBytes).toBe(0);
  });

  it('rejects an empty channel list', () => {
    expect(() => encodeWav([], 44100)).toThrow(/at least one channel/);
  });

  it('rejects an invalid sample rate', () => {
    expect(() => encodeWav([sine(10)], 0)).toThrow(/sample rate/);
    expect(() => encodeWav([sine(10)], Number.NaN)).toThrow(/sample rate/);
  });

  it('rejects an unsupported bit depth', () => {
    expect(() => encodeWav([sine(10)], 44100, { bitDepth: 8 as never })).toThrow(/bit depth/);
  });
});

describe('readWavHeader', () => {
  it('rejects a buffer too short to be a WAV', () => {
    expect(() => readWavHeader(new ArrayBuffer(10))).toThrow(/too short/);
  });

  it('rejects a file that is not RIFF/WAVE', () => {
    const buffer = new ArrayBuffer(64);
    expect(() => readWavHeader(buffer)).toThrow(/RIFF/);
  });
});
