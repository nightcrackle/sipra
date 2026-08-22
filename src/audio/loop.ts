/**
 * Loop regions.
 *
 * A loop is stored as an ordered `[start, end)` pair, but a user drags in
 * whichever direction they like and often overshoots the ends of the
 * track. Normalising here keeps the transport from ever seeing a backwards
 * or out-of-range region.
 */

/** Shorter than this and playback becomes a buzz rather than a loop. */
export const MIN_LOOP_SECONDS = 0.05;

export interface LoopRegion {
  start: number;
  end: number;
}

/**
 * Order and clamp a dragged region.
 *
 * Returns `null` for a region too short to be a deliberate selection —
 * that is a click, not a drag, and the caller should treat it as one.
 */
export function normaliseLoop(
  anchorSeconds: number,
  cursorSeconds: number,
  totalSeconds: number,
): LoopRegion | null {
  if (!Number.isFinite(anchorSeconds) || !Number.isFinite(cursorSeconds)) return null;
  const total = Math.max(0, totalSeconds);
  if (total <= 0) return null;

  const low = Math.max(0, Math.min(anchorSeconds, cursorSeconds));
  const high = Math.min(total, Math.max(anchorSeconds, cursorSeconds));
  if (high - low < MIN_LOOP_SECONDS) return null;
  return { start: low, end: high };
}

export function loopLength(loop: LoopRegion | null): number {
  return loop ? Math.max(0, loop.end - loop.start) : 0;
}

export function isInsideLoop(loop: LoopRegion | null, seconds: number): boolean {
  if (!loop) return false;
  return seconds >= loop.start && seconds < loop.end;
}

/**
 * Where playback should resume, given the current position.
 *
 * Called on every transport tick while looping. A position past the end
 * wraps back to the start; a position before the loop jumps forward into
 * it, so enabling a loop while playing earlier in the track does something
 * sensible instead of nothing.
 */
export function wrapToLoop(loop: LoopRegion | null, seconds: number): number {
  if (!loop || loopLength(loop) < MIN_LOOP_SECONDS) return seconds;
  if (seconds >= loop.end) return loop.start;
  if (seconds < loop.start) return loop.start;
  return seconds;
}

/** Nudge one edge, keeping the region ordered and long enough. */
export function adjustLoopEdge(
  loop: LoopRegion,
  edge: 'start' | 'end',
  seconds: number,
  totalSeconds: number,
): LoopRegion {
  const total = Math.max(0, totalSeconds);
  if (edge === 'start') {
    const start = Math.max(0, Math.min(seconds, loop.end - MIN_LOOP_SECONDS));
    return { start, end: loop.end };
  }
  const end = Math.min(total, Math.max(seconds, loop.start + MIN_LOOP_SECONDS));
  return { start: loop.start, end };
}

/** Slide a whole region without changing its length. */
export function moveLoop(
  loop: LoopRegion,
  deltaSeconds: number,
  totalSeconds: number,
): LoopRegion {
  const length = loopLength(loop);
  const start = Math.max(0, Math.min(loop.start + deltaSeconds, Math.max(0, totalSeconds - length)));
  return { start, end: start + length };
}

/**
 * Snap loop edges to the nearest beat.
 *
 * Only snaps when an edge is already within `toleranceSeconds` of a beat,
 * so a deliberately off-grid selection is left alone.
 */
export function snapLoopToBeats(
  loop: LoopRegion,
  beatTimes: readonly number[],
  toleranceSeconds = 0.12,
): LoopRegion {
  if (beatTimes.length === 0) return loop;
  const snap = (value: number): number => {
    let best = value;
    let bestDistance = toleranceSeconds;
    for (const beat of beatTimes) {
      const distance = Math.abs(beat - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = beat;
      }
    }
    return best;
  };

  const start = snap(loop.start);
  const end = snap(loop.end);
  if (end - start < MIN_LOOP_SECONDS) return loop;
  return { start, end };
}

/** Extend a loop to a whole number of bars, given a tempo. */
export function extendToBars(
  loop: LoopRegion,
  bpm: number | null,
  beatsPerBar = 4,
  totalSeconds = Infinity,
): LoopRegion {
  if (!bpm || bpm <= 0) return loop;
  const barSeconds = (60 / bpm) * beatsPerBar;
  if (barSeconds <= 0) return loop;
  const bars = Math.max(1, Math.round(loopLength(loop) / barSeconds));
  const end = Math.min(totalSeconds, loop.start + bars * barSeconds);
  if (end - loop.start < MIN_LOOP_SECONDS) return loop;
  return { start: loop.start, end };
}
