import { describe, expect, it } from 'vitest';

import {
  backingStems,
  clampGainDb,
  createLanes,
  dbToFader,
  dbToGain,
  faderToDb,
  gainToDb,
  type LaneState,
  MAX_GAIN_DB,
  MIN_GAIN_DB,
  resetLanes,
  resolveMix,
  setGain,
  setSelection,
  toggleMute,
  toggleSelection,
  toggleSolo,
} from '@shared/mix';
import { FOUR_STEM_SET, type StemId } from '@shared/stems';

const lanes = (): LaneState[] => createLanes(FOUR_STEM_SET);

describe('gain conversion', () => {
  it.each([
    [0, 1],
    [-6.0206, 0.5],
    [6.0206, 2],
    [-20, 0.1],
  ])('converts %d dB to a gain of %f', (db, gain) => {
    expect(dbToGain(db)).toBeCloseTo(gain, 4);
  });

  it('treats anything at or below the floor as silence', () => {
    expect(dbToGain(MIN_GAIN_DB)).toBe(0);
    expect(dbToGain(-120)).toBe(0);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(Number.NaN)).toBe(0);
  });

  it('round-trips through gainToDb', () => {
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 5);
  });

  it('reports negative infinity for a zero gain', () => {
    expect(gainToDb(0)).toBe(-Infinity);
  });

  it('clamps out-of-range values', () => {
    expect(clampGainDb(999)).toBe(MAX_GAIN_DB);
    expect(clampGainDb(-999)).toBe(MIN_GAIN_DB);
    expect(clampGainDb(Number.NaN)).toBe(MIN_GAIN_DB);
  });
});

describe('resolveMix', () => {
  it('passes every selected lane at unity by default', () => {
    const { gains } = resolveMix(lanes());
    for (const stem of FOUR_STEM_SET) expect(gains[stem]).toBeCloseTo(1, 6);
  });

  it('silences a muted lane', () => {
    const { gains } = resolveMix(toggleMute(lanes(), 'drums'));
    expect(gains.drums).toBe(0);
    expect(gains.vocals).toBeCloseTo(1, 6);
  });

  it('silences everything except a soloed lane', () => {
    const { gains, anySolo } = resolveMix(toggleSolo(lanes(), 'vocals'));
    expect(anySolo).toBe(true);
    expect(gains.vocals).toBeCloseTo(1, 6);
    expect(gains.drums).toBe(0);
    expect(gains.bass).toBe(0);
  });

  it('lets several lanes solo together', () => {
    const soloed = toggleSolo(toggleSolo(lanes(), 'vocals'), 'drums');
    const { gains } = resolveMix(soloed);
    expect(gains.vocals).toBeGreaterThan(0);
    expect(gains.drums).toBeGreaterThan(0);
    expect(gains.bass).toBe(0);
  });

  it('keeps a lane that is both muted and soloed silent', () => {
    // This matches a mixing desk: mute wins.
    const state = toggleMute(toggleSolo(lanes(), 'vocals'), 'vocals');
    expect(resolveMix(state).gains.vocals).toBe(0);
  });

  it('applies the lane fader', () => {
    const state = setGain(lanes(), 'bass', -6.0206);
    expect(resolveMix(state).gains.bass).toBeCloseTo(0.5, 3);
  });

  it('applies the master fader on top of the lane fader', () => {
    const state = setGain(lanes(), 'bass', -6.0206);
    const { gains } = resolveMix(state, { masterGainDb: -6.0206 });
    expect(gains.bass).toBeCloseTo(0.25, 3);
  });

  it('silences unselected lanes when there is no backing bus', () => {
    const state = setSelection(lanes(), ['vocals']);
    const { gains } = resolveMix(state, { backingBusDb: null });
    expect(gains.vocals).toBeCloseTo(1, 6);
    expect(gains.drums).toBe(0);
  });

  it('plays unselected lanes quietly when a backing level is set', () => {
    const state = setSelection(lanes(), ['vocals']);
    const { gains } = resolveMix(state, { backingBusDb: -6.0206 });
    expect(gains.vocals).toBeCloseTo(1, 6);
    expect(gains.drums).toBeCloseTo(0.5, 3);
    expect(gains.bass).toBeCloseTo(0.5, 3);
  });

  it('still respects mute inside the backing bus', () => {
    const state = toggleMute(setSelection(lanes(), ['vocals']), 'drums');
    expect(resolveMix(state, { backingBusDb: -6 }).gains.drums).toBe(0);
  });

  it('swaps to the original rather than blending with it', () => {
    // A/B has to be a true swap, or the comparison is meaningless.
    const { gains, originalGain } = resolveMix(lanes(), { referenceOriginal: true });
    for (const stem of FOUR_STEM_SET) expect(gains[stem]).toBe(0);
    expect(originalGain).toBeCloseTo(1, 6);
  });

  it('applies master gain to the reference lane too', () => {
    const { originalGain } = resolveMix(lanes(), {
      referenceOriginal: true,
      masterGainDb: -6.0206,
    });
    expect(originalGain).toBeCloseTo(0.5, 3);
  });

  it('lists the audible stems', () => {
    const state = toggleMute(lanes(), 'other');
    expect(resolveMix(state).audibleStems).toEqual(['vocals', 'drums', 'bass']);
  });
});

describe('lane state transitions', () => {
  it('creates one lane per stem, all selected', () => {
    const created = lanes();
    expect(created).toHaveLength(4);
    expect(created.every((lane) => lane.selected && !lane.muted && !lane.solo)).toBe(true);
  });

  it('toggling solo twice on the only soloed lane clears solo', () => {
    // Every DAW does this, and a second click that changes nothing would
    // feel broken.
    const once = toggleSolo(lanes(), 'vocals');
    const twice = toggleSolo(once, 'vocals');
    expect(twice.some((lane) => lane.solo)).toBe(false);
  });

  it('toggling solo off with others still soloed leaves them soloed', () => {
    let state = toggleSolo(lanes(), 'vocals');
    state = toggleSolo(state, 'drums');
    state = toggleSolo(state, 'vocals');
    expect(state.find((lane) => lane.stemId === 'drums')?.solo).toBe(true);
    expect(state.find((lane) => lane.stemId === 'vocals')?.solo).toBe(false);
  });

  it('ignores a solo for a stem that is not present', () => {
    expect(toggleSolo(lanes(), 'piano')).toHaveLength(4);
  });

  it('clamps a gain set beyond the fader range', () => {
    expect(setGain(lanes(), 'bass', 99).find((l) => l.stemId === 'bass')?.gainDb).toBe(MAX_GAIN_DB);
  });

  it('refuses an empty selection and selects everything instead', () => {
    // An all-silent workspace with no visible cause reads as a bug.
    const state = setSelection(lanes(), []);
    expect(state.every((lane) => lane.selected)).toBe(true);
  });

  it('refuses to deselect the last selected lane', () => {
    let state = setSelection(lanes(), ['vocals']);
    state = toggleSelection(state, 'vocals');
    expect(state.every((lane) => lane.selected)).toBe(true);
  });

  it('resets faders, mutes, solos and selection', () => {
    let state = setGain(lanes(), 'bass', -20);
    state = toggleMute(state, 'drums');
    state = toggleSolo(state, 'vocals');
    state = setSelection(state, ['vocals']);
    const reset = resetLanes(state);
    expect(
      reset.every((lane) => lane.gainDb === 0 && !lane.muted && !lane.solo && lane.selected),
    ).toBe(true);
  });

  it('reports which stems feed the backing bus', () => {
    const state = setSelection(lanes(), ['vocals']);
    expect(backingStems(state)).toEqual(['drums', 'bass', 'other']);
  });

  it('leaves muted stems out of the backing bus', () => {
    const state = toggleMute(setSelection(lanes(), ['vocals']), 'drums');
    expect(backingStems(state)).toEqual(['bass', 'other']);
  });

  it('never mutates the array it was given', () => {
    const original = lanes();
    const snapshot = JSON.stringify(original);
    toggleMute(original, 'drums');
    toggleSolo(original, 'vocals');
    setGain(original, 'bass', -12);
    setSelection(original, ['vocals'] as StemId[]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('fader taper', () => {
  it('puts unity gain around three-quarters of the travel', () => {
    expect(faderToDb(0.78)).toBeCloseTo(0, 5);
  });

  it('reaches the floor at the bottom and the ceiling at the top', () => {
    expect(faderToDb(0)).toBe(MIN_GAIN_DB);
    expect(faderToDb(1)).toBeCloseTo(MAX_GAIN_DB, 5);
  });

  it('is monotonic across the travel', () => {
    let previous = -Infinity;
    for (let position = 0; position <= 1.0001; position += 0.02) {
      const db = faderToDb(position);
      expect(db).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = db;
    }
  });

  it('round-trips a decibel value through the fader position', () => {
    for (const db of [-40, -18, -6, 0, 3, 6]) {
      expect(faderToDb(dbToFader(db))).toBeCloseTo(db, 4);
    }
  });

  it('clamps a position outside 0-1', () => {
    expect(faderToDb(-5)).toBe(MIN_GAIN_DB);
    expect(faderToDb(5)).toBeCloseTo(MAX_GAIN_DB, 5);
  });

  it('gives finer control near unity than at the bottom', () => {
    // Most mixing happens in the top few dB; the taper should reflect that.
    const nearUnity = Math.abs(faderToDb(0.78) - faderToDb(0.73));
    const nearFloor = Math.abs(faderToDb(0.1) - faderToDb(0.05));
    expect(nearUnity).toBeLessThan(nearFloor);
  });
});
