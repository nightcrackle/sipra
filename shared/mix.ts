/**
 * Mix maths.
 *
 * Kept as pure functions with no Web Audio dependency so the rules that
 * decide what the user actually hears — solo beats everything, mute beats
 * solo, unselected stems feed the backing bus — can be unit tested rather
 * than discovered by ear.
 */

import type { StemId } from './stems';

/** Anything at or below this is treated as silence rather than a tiny gain. */
export const SILENCE_DB = -60;
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 12;

export interface LaneState {
  stemId: StemId;
  /** Fader position in dB. 0 is unity. */
  gainDb: number;
  muted: boolean;
  solo: boolean;
  /** Whether this stem is part of the user's current selection. */
  selected: boolean;
}

export interface MixOptions {
  masterGainDb?: number;
  /** Play the untouched original instead of the stem mix. */
  referenceOriginal?: boolean;
  /**
   * Route stems the user has *not* selected into a single backing bus at
   * this level, instead of silencing them.
   */
  backingBusDb?: number | null;
}

export interface ResolvedMix {
  /** Linear gain per stem, including master. Absent stems are silent. */
  gains: Record<string, number>;
  /** Linear gain for the original-mix reference lane. */
  originalGain: number;
  anySolo: boolean;
  audibleStems: StemId[];
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= SILENCE_DB) return 0;
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (!(gain > 0)) return -Infinity;
  return 20 * Math.log10(gain);
}

export function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return MIN_GAIN_DB;
  return Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, db));
}

/**
 * Decide the linear gain of every lane.
 *
 * Rules, in the order they are applied:
 *   1. If any lane is soloed, only soloed lanes can sound.
 *   2. A muted lane is silent even if it is also soloed.
 *   3. A lane the user has not selected is silent, unless a backing bus
 *      level is set, in which case it sounds at that level.
 *   4. The lane fader and then the master fader are applied.
 *
 * When `referenceOriginal` is on, every stem is silenced and the original
 * mix plays at master level, so A/B is a true swap rather than a blend.
 */
export function resolveMix(lanes: readonly LaneState[], options: MixOptions = {}): ResolvedMix {
  const master = dbToGain(options.masterGainDb ?? 0);
  const anySolo = lanes.some((lane) => lane.solo);

  if (options.referenceOriginal) {
    return {
      gains: Object.fromEntries(lanes.map((lane) => [lane.stemId, 0])),
      originalGain: master,
      anySolo,
      audibleStems: [],
    };
  }

  const gains: Record<string, number> = {};
  const audible: StemId[] = [];
  const backingGain =
    options.backingBusDb === null || options.backingBusDb === undefined
      ? null
      : dbToGain(options.backingBusDb);

  for (const lane of lanes) {
    let gain: number;
    if (lane.muted || (anySolo && !lane.solo)) {
      gain = 0;
    } else if (lane.selected) {
      gain = dbToGain(lane.gainDb);
    } else if (backingGain !== null) {
      // Unselected stems still play, quieter, as the backing track.
      gain = backingGain * dbToGain(lane.gainDb);
    } else {
      gain = 0;
    }

    gain *= master;
    gains[lane.stemId] = gain;
    if (gain > 0) audible.push(lane.stemId);
  }

  return { gains, originalGain: 0, anySolo, audibleStems: audible };
}

/** Lanes at their default position: everything selected, nothing muted. */
export function createLanes(stemIds: readonly StemId[]): LaneState[] {
  return stemIds.map((stemId) => ({
    stemId,
    gainDb: 0,
    muted: false,
    solo: false,
    selected: true,
  }));
}

/**
 * Toggle solo on one lane.
 *
 * Soloing the only currently-soloed lane clears solo entirely, which is
 * what every DAW does and what a user expects from a second click.
 */
export function toggleSolo(lanes: readonly LaneState[], stemId: StemId): LaneState[] {
  const target = lanes.find((lane) => lane.stemId === stemId);
  if (!target) return [...lanes];
  const soloed = lanes.filter((lane) => lane.solo);
  const clearAll = target.solo && soloed.length === 1;
  return lanes.map((lane) =>
    lane.stemId === stemId
      ? { ...lane, solo: clearAll ? false : !lane.solo }
      : clearAll
        ? { ...lane, solo: false }
        : lane,
  );
}

export function toggleMute(lanes: readonly LaneState[], stemId: StemId): LaneState[] {
  return lanes.map((lane) =>
    lane.stemId === stemId ? { ...lane, muted: !lane.muted } : lane,
  );
}

export function setGain(lanes: readonly LaneState[], stemId: StemId, gainDb: number): LaneState[] {
  return lanes.map((lane) =>
    lane.stemId === stemId ? { ...lane, gainDb: clampGainDb(gainDb) } : lane,
  );
}

/**
 * Set the stem selection.
 *
 * An empty selection is refused: it would produce silence with no obvious
 * cause, which reads as a broken app rather than a deliberate state.
 */
export function setSelection(
  lanes: readonly LaneState[],
  selected: readonly StemId[],
): LaneState[] {
  const wanted = new Set(selected);
  if (wanted.size === 0) return lanes.map((lane) => ({ ...lane, selected: true }));
  return lanes.map((lane) => ({ ...lane, selected: wanted.has(lane.stemId) }));
}

export function toggleSelection(lanes: readonly LaneState[], stemId: StemId): LaneState[] {
  const next = lanes.map((lane) =>
    lane.stemId === stemId ? { ...lane, selected: !lane.selected } : lane,
  );
  return next.some((lane) => lane.selected) ? next : lanes.map((l) => ({ ...l, selected: true }));
}

export function resetLanes(lanes: readonly LaneState[]): LaneState[] {
  return lanes.map((lane) => ({
    ...lane,
    gainDb: 0,
    muted: false,
    solo: false,
    selected: true,
  }));
}

/** Stems that would feed the backing bus for the current selection. */
export function backingStems(lanes: readonly LaneState[]): StemId[] {
  return lanes.filter((lane) => !lane.selected && !lane.muted).map((lane) => lane.stemId);
}

/** Fader position at which the lane sits at unity gain. */
export const UNITY_POSITION = 0.78;

/**
 * Convert a fader position (0-1) to dB with a musically useful taper.
 *
 * The important property is where the *resolution* goes. Mixing decisions
 * happen in the top handful of decibels, so the curve is shallow there —
 * a few percent of travel is about a decibel — and steep at the bottom,
 * where the difference between -45 and -52 dB is inaudible anyway. A
 * linear map gets this exactly backwards and makes fine balancing
 * impossible.
 *
 * Unity sits at `UNITY_POSITION`, with the remaining travel covering the
 * boost range linearly.
 */
export function faderToDb(position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  if (clamped <= 0) return MIN_GAIN_DB;
  if (clamped >= UNITY_POSITION) {
    return ((clamped - UNITY_POSITION) / (1 - UNITY_POSITION)) * MAX_GAIN_DB;
  }
  // Cube-root taper: shallow near unity, steep near silence.
  const shaped = Math.cbrt(clamped / UNITY_POSITION);
  return MIN_GAIN_DB * (1 - shaped);
}

export function dbToFader(db: number): number {
  const clamped = clampGainDb(db);
  if (clamped >= 0) {
    return UNITY_POSITION + (clamped / MAX_GAIN_DB) * (1 - UNITY_POSITION);
  }
  const shaped = 1 - clamped / MIN_GAIN_DB;
  return shaped ** 3 * UNITY_POSITION;
}
