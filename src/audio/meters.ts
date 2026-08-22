/**
 * Level metering.
 *
 * A meter that simply plots the current sample value is unreadable — it
 * flickers at frame rate and hides transients. Real meters have
 * *ballistics*: a fast attack so nothing is missed, a slow release so the
 * eye can follow, and a peak hold that lingers.
 *
 * All of this is pure state maths, kept out of the React components so it
 * can be tested with a synthetic signal instead of watched.
 */

/** Bottom of the meter scale. Below this a signal reads as silence. */
export const METER_FLOOR_DB = -60;
export const METER_CEILING_DB = 6;

/** How long a peak marker stays put before it starts falling, in ms. */
export const PEAK_HOLD_MS = 1200;
/** How fast the peak marker falls once the hold expires, in dB/second. */
export const PEAK_FALL_DB_PER_SECOND = 20;

/**
 * Release rate of the bar itself, in dB/second, per mode.
 *
 * Peak mode tracks quickly so the bar follows the material. RMS mode falls
 * more slowly, which is the point of an averaging meter: it should show
 * perceived level rather than chase every transient.
 */
export const BAR_FALL_DB_PER_SECOND: Record<'peak' | 'rms', number> = {
  peak: 26,
  rms: 14,
};

/** How long the clip indicator stays lit after an over, in ms. */
export const CLIP_HOLD_MS = 2000;

export interface MeterState {
  /** Smoothed level in dB, for the bar. */
  levelDb: number;
  /** Held peak in dB, for the marker. */
  peakDb: number;
  /** When the held peak was last set, in ms. */
  peakHeldAt: number;
  /** When the last sample above full scale happened, or 0. */
  clippedAt: number;
}

export function createMeterState(now = 0): MeterState {
  return {
    levelDb: METER_FLOOR_DB,
    peakDb: METER_FLOOR_DB,
    peakHeldAt: now,
    clippedAt: 0,
  };
}

export function amplitudeToDb(amplitude: number): number {
  if (!(amplitude > 0)) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(amplitude));
}

/** RMS of a block of samples. */
export function blockRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function blockPeak(samples: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

export interface MeterUpdate {
  /** Peak amplitude in this block, linear. */
  peak: number;
  /** RMS amplitude in this block, linear. */
  rms: number;
  /** Timestamp in ms. */
  now: number;
  /** Seconds since the previous update, for release rates. */
  deltaSeconds: number;
  /** Which figure drives the bar. */
  mode?: 'peak' | 'rms';
}

/**
 * Advance one meter by one frame.
 *
 * The bar jumps straight up to a louder reading (instant attack, so a
 * transient is never missed) and falls at a fixed rate. The peak marker
 * holds, then falls more slowly.
 */
export function updateMeter(state: MeterState, update: MeterUpdate): MeterState {
  const mode = update.mode ?? 'peak';
  const source = mode === 'rms' ? update.rms : update.peak;
  const incomingDb = amplitudeToDb(source);
  const delta = Math.max(0, update.deltaSeconds);

  const fallRate = BAR_FALL_DB_PER_SECOND[mode];
  const released = Math.max(METER_FLOOR_DB, state.levelDb - fallRate * delta);
  const levelDb = Math.max(released, incomingDb);

  const peakDb = amplitudeToDb(update.peak);
  let heldPeak = state.peakDb;
  let peakHeldAt = state.peakHeldAt;

  if (peakDb >= heldPeak) {
    heldPeak = peakDb;
    peakHeldAt = update.now;
  } else if (update.now - peakHeldAt > PEAK_HOLD_MS) {
    heldPeak = Math.max(METER_FLOOR_DB, heldPeak - PEAK_FALL_DB_PER_SECOND * delta);
  }

  // Anything at or above full scale will clip on export to integer PCM.
  const clippedAt = update.peak >= 1 ? update.now : state.clippedAt;

  return { levelDb, peakDb: heldPeak, peakHeldAt, clippedAt };
}

export function isClipping(state: MeterState, now: number): boolean {
  return state.clippedAt > 0 && now - state.clippedAt < CLIP_HOLD_MS;
}

export function clearClip(state: MeterState): MeterState {
  return { ...state, clippedAt: 0 };
}

/**
 * Shape of the meter scale.
 *
 * An exponent above 1 expands the loud end and compresses the quiet end.
 * At 1.6 the top 12 dB takes about 40% of the meter's length instead of
 * the 18% a linear dB scale would give it — which matters because that is
 * the range every mixing decision lives in, while the difference between
 * -45 and -52 dB is not worth a pixel.
 */
export const METER_CURVE = 1.6;

/** Map dB onto 0-1 for drawing. */
export function dbToMeterPosition(
  db: number,
  floor: number = METER_FLOOR_DB,
  ceiling: number = METER_CEILING_DB,
): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.min(ceiling, Math.max(floor, db));
  const range = ceiling - floor;
  if (range <= 0) return 0;
  const linear = (clamped - floor) / range;
  return linear ** METER_CURVE;
}

export function meterPositionToDb(
  position: number,
  floor: number = METER_FLOOR_DB,
  ceiling: number = METER_CEILING_DB,
): number {
  const clamped = Math.min(1, Math.max(0, position));
  return floor + clamped ** (1 / METER_CURVE) * (ceiling - floor);
}

/** Colour zones so a hot stem is obvious at a glance. */
export function meterZone(db: number): 'safe' | 'warm' | 'hot' | 'over' {
  if (db >= 0) return 'over';
  if (db >= -3) return 'hot';
  if (db >= -12) return 'warm';
  return 'safe';
}
