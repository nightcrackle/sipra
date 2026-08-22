import { describe, expect, it } from 'vitest';

import {
  amplitudeToDb,
  BAR_FALL_DB_PER_SECOND,
  blockPeak,
  blockRms,
  clearClip,
  CLIP_HOLD_MS,
  createMeterState,
  dbToMeterPosition,
  isClipping,
  METER_CEILING_DB,
  METER_FLOOR_DB,
  meterPositionToDb,
  meterZone,
  PEAK_HOLD_MS,
  updateMeter,
} from '../src/audio/meters';

const block = (value: number, length = 128): Float32Array => new Float32Array(length).fill(value);

describe('amplitude conversion', () => {
  it('maps full scale to 0 dB', () => {
    expect(amplitudeToDb(1)).toBeCloseTo(0, 6);
  });

  it('maps half amplitude to about -6 dB', () => {
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.02, 2);
  });

  it('floors silence rather than returning negative infinity', () => {
    expect(amplitudeToDb(0)).toBe(METER_FLOOR_DB);
    expect(amplitudeToDb(-1)).toBe(METER_FLOOR_DB);
  });

  it('floors anything below the scale', () => {
    expect(amplitudeToDb(1e-9)).toBe(METER_FLOOR_DB);
  });
});

describe('block measurement', () => {
  it('measures RMS of a constant block', () => {
    expect(blockRms(block(0.5))).toBeCloseTo(0.5, 6);
  });

  it('measures RMS of a sine as about 0.707 of its peak', () => {
    const sine = Float32Array.from({ length: 1024 }, (_v, i) => Math.sin((i / 1024) * Math.PI * 2));
    expect(blockRms(sine)).toBeCloseTo(0.7071, 2);
  });

  it('measures the absolute peak', () => {
    expect(blockPeak(Float32Array.from([0.1, -0.9, 0.4]))).toBeCloseTo(0.9, 6);
  });

  it('handles an empty block', () => {
    expect(blockRms(new Float32Array(0))).toBe(0);
    expect(blockPeak(new Float32Array(0))).toBe(0);
  });
});

describe('meter ballistics', () => {
  it('jumps straight up so a transient is never missed', () => {
    const state = updateMeter(createMeterState(), {
      peak: 0.5,
      rms: 0.5,
      now: 100,
      deltaSeconds: 0.016,
    });
    expect(state.levelDb).toBeCloseTo(-6.02, 1);
  });

  it('falls at a bounded rate rather than snapping down', () => {
    const loud = updateMeter(createMeterState(), {
      peak: 1,
      rms: 1,
      now: 0,
      deltaSeconds: 0.016,
    });
    const quiet = updateMeter(loud, { peak: 0, rms: 0, now: 100, deltaSeconds: 0.1 });
    expect(quiet.levelDb).toBeLessThan(loud.levelDb);
    expect(quiet.levelDb).toBeGreaterThan(METER_FLOOR_DB);
  });

  it('reaches the floor eventually', () => {
    let state = updateMeter(createMeterState(), { peak: 1, rms: 1, now: 0, deltaSeconds: 0 });
    for (let index = 1; index <= 60; index += 1) {
      state = updateMeter(state, { peak: 0, rms: 0, now: index * 100, deltaSeconds: 0.1 });
    }
    expect(state.levelDb).toBe(METER_FLOOR_DB);
  });

  it('holds the peak marker before letting it fall', () => {
    // A marker that falls immediately is a marker nobody can read.
    const loud = updateMeter(createMeterState(), { peak: 1, rms: 1, now: 0, deltaSeconds: 0.016 });
    const during = updateMeter(loud, {
      peak: 0.01,
      rms: 0.01,
      now: PEAK_HOLD_MS - 100,
      deltaSeconds: 0.016,
    });
    expect(during.peakDb).toBeCloseTo(loud.peakDb, 6);

    const after = updateMeter(during, {
      peak: 0.01,
      rms: 0.01,
      now: PEAK_HOLD_MS + 500,
      deltaSeconds: 0.5,
    });
    expect(after.peakDb).toBeLessThan(during.peakDb);
  });

  it('raises the peak marker immediately for a louder reading', () => {
    const first = updateMeter(createMeterState(), {
      peak: 0.2,
      rms: 0.2,
      now: 0,
      deltaSeconds: 0.016,
    });
    const second = updateMeter(first, { peak: 0.9, rms: 0.9, now: 16, deltaSeconds: 0.016 });
    expect(second.peakDb).toBeGreaterThan(first.peakDb);
  });

  it('follows RMS rather than peak in RMS mode', () => {
    const state = updateMeter(createMeterState(), {
      peak: 1,
      rms: 0.1,
      now: 0,
      deltaSeconds: 0.016,
      mode: 'rms',
    });
    expect(state.levelDb).toBeCloseTo(-20, 1);
  });

  it('still tracks true peak for the marker in RMS mode', () => {
    const state = updateMeter(createMeterState(), {
      peak: 1,
      rms: 0.1,
      now: 0,
      deltaSeconds: 0.016,
      mode: 'rms',
    });
    expect(state.peakDb).toBeCloseTo(0, 1);
  });

  it('releases more slowly in RMS mode than in peak mode', () => {
    // An averaging meter that chases transients defeats its own purpose.
    expect(BAR_FALL_DB_PER_SECOND.rms).toBeLessThan(BAR_FALL_DB_PER_SECOND.peak);

    const start = { peak: 1, rms: 1, now: 0, deltaSeconds: 0 } as const;
    const peakLoud = updateMeter(createMeterState(), { ...start, mode: 'peak' });
    const rmsLoud = updateMeter(createMeterState(), { ...start, mode: 'rms' });
    const silence = { peak: 0, rms: 0, now: 500, deltaSeconds: 0.5 } as const;
    const peakAfter = updateMeter(peakLoud, { ...silence, mode: 'peak' });
    const rmsAfter = updateMeter(rmsLoud, { ...silence, mode: 'rms' });
    expect(rmsAfter.levelDb).toBeGreaterThan(peakAfter.levelDb);
  });

  it('copes with a zero time delta', () => {
    const state = updateMeter(createMeterState(), { peak: 0.5, rms: 0.5, now: 0, deltaSeconds: 0 });
    expect(Number.isFinite(state.levelDb)).toBe(true);
  });
});

describe('clip detection', () => {
  it('lights on a sample at full scale', () => {
    const state = updateMeter(createMeterState(), {
      peak: 1,
      rms: 0.5,
      now: 1000,
      deltaSeconds: 0.016,
    });
    expect(isClipping(state, 1000)).toBe(true);
  });

  it('does not light below full scale', () => {
    const state = updateMeter(createMeterState(), {
      peak: 0.99,
      rms: 0.5,
      now: 1000,
      deltaSeconds: 0.016,
    });
    expect(isClipping(state, 1000)).toBe(false);
  });

  it('stays lit long enough to be seen', () => {
    const state = updateMeter(createMeterState(), {
      peak: 1.5,
      rms: 1,
      now: 1000,
      deltaSeconds: 0.016,
    });
    expect(isClipping(state, 1000 + CLIP_HOLD_MS - 100)).toBe(true);
    expect(isClipping(state, 1000 + CLIP_HOLD_MS + 100)).toBe(false);
  });

  it('can be cleared', () => {
    const state = updateMeter(createMeterState(), {
      peak: 1,
      rms: 1,
      now: 1000,
      deltaSeconds: 0.016,
    });
    expect(isClipping(clearClip(state), 1000)).toBe(false);
  });
});

describe('meter scale', () => {
  it('puts the floor at zero and the ceiling at one', () => {
    expect(dbToMeterPosition(METER_FLOOR_DB)).toBeCloseTo(0, 6);
    expect(dbToMeterPosition(METER_CEILING_DB)).toBeCloseTo(1, 6);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (let db = METER_FLOOR_DB; db <= METER_CEILING_DB; db += 1) {
      const position = dbToMeterPosition(db);
      expect(position).toBeGreaterThanOrEqual(previous);
      previous = position;
    }
  });

  it('gives the top of the scale a disproportionate share of the length', () => {
    // The last 12 dB is where mixing decisions happen.
    const topShare = 1 - dbToMeterPosition(-12);
    expect(topShare).toBeGreaterThan(12 / (METER_CEILING_DB - METER_FLOOR_DB));
  });

  it('clamps out-of-range input', () => {
    expect(dbToMeterPosition(-999)).toBe(0);
    expect(dbToMeterPosition(999)).toBe(1);
    expect(dbToMeterPosition(Number.NaN)).toBe(0);
  });

  it('round-trips through the inverse', () => {
    for (const db of [-48, -24, -12, -6, 0, 3]) {
      expect(meterPositionToDb(dbToMeterPosition(db))).toBeCloseTo(db, 4);
    }
  });

  it.each([
    [-40, 'safe'],
    [-13, 'safe'],
    [-6, 'warm'],
    [-1, 'hot'],
    [0, 'over'],
    [3, 'over'],
  ])('puts %d dB in the %s zone', (db, zone) => {
    expect(meterZone(db)).toBe(zone);
  });
});
