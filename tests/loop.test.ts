import { describe, expect, it } from 'vitest';

import {
  adjustLoopEdge,
  extendToBars,
  isInsideLoop,
  loopLength,
  MIN_LOOP_SECONDS,
  moveLoop,
  normaliseLoop,
  snapLoopToBeats,
  wrapToLoop,
} from '../src/audio/loop';

describe('normaliseLoop', () => {
  it('orders a forwards drag', () => {
    expect(normaliseLoop(10, 20, 100)).toEqual({ start: 10, end: 20 });
  });

  it('orders a backwards drag the same way', () => {
    expect(normaliseLoop(20, 10, 100)).toEqual({ start: 10, end: 20 });
  });

  it('clamps to the track', () => {
    expect(normaliseLoop(-10, 200, 100)).toEqual({ start: 0, end: 100 });
  });

  it('returns null for a drag too short to be deliberate', () => {
    // That is a click, and the caller should treat it as a seek.
    expect(normaliseLoop(10, 10.01, 100)).toBeNull();
    expect(normaliseLoop(10, 10, 100)).toBeNull();
  });

  it('accepts a drag at exactly the minimum length', () => {
    expect(normaliseLoop(10, 10 + MIN_LOOP_SECONDS, 100)).not.toBeNull();
  });

  it('returns null for an empty track', () => {
    expect(normaliseLoop(0, 10, 0)).toBeNull();
  });

  it('rejects non-finite input rather than guessing at it', () => {
    expect(normaliseLoop(Number.NaN, 10, 100)).toBeNull();
    expect(normaliseLoop(0, Infinity, 100)).toBeNull();
    expect(normaliseLoop(-Infinity, 10, 100)).toBeNull();
  });
});

describe('loop geometry', () => {
  it('measures length', () => {
    expect(loopLength({ start: 5, end: 12 })).toBe(7);
    expect(loopLength(null)).toBe(0);
  });

  it('tests containment with a half-open interval', () => {
    const loop = { start: 5, end: 10 };
    expect(isInsideLoop(loop, 5)).toBe(true);
    expect(isInsideLoop(loop, 7)).toBe(true);
    expect(isInsideLoop(loop, 10)).toBe(false);
    expect(isInsideLoop(loop, 4.9)).toBe(false);
    expect(isInsideLoop(null, 7)).toBe(false);
  });
});

describe('wrapToLoop', () => {
  const loop = { start: 10, end: 20 };

  it('leaves a position inside the loop alone', () => {
    expect(wrapToLoop(loop, 15)).toBe(15);
  });

  it('wraps back to the start at the end', () => {
    expect(wrapToLoop(loop, 20)).toBe(10);
    expect(wrapToLoop(loop, 25)).toBe(10);
  });

  it('jumps forward into the loop from before it', () => {
    // Enabling a loop while playing earlier should do something sensible.
    expect(wrapToLoop(loop, 3)).toBe(10);
  });

  it('passes through when there is no loop', () => {
    expect(wrapToLoop(null, 15)).toBe(15);
  });

  it('passes through for a degenerate loop', () => {
    expect(wrapToLoop({ start: 10, end: 10.001 }, 15)).toBe(15);
  });
});

describe('adjustLoopEdge', () => {
  const loop = { start: 10, end: 20 };

  it('moves the start', () => {
    expect(adjustLoopEdge(loop, 'start', 12, 100).start).toBe(12);
  });

  it('moves the end', () => {
    expect(adjustLoopEdge(loop, 'end', 18, 100).end).toBe(18);
  });

  it('keeps the region ordered when the start is dragged past the end', () => {
    const adjusted = adjustLoopEdge(loop, 'start', 50, 100);
    expect(adjusted.start).toBeLessThan(adjusted.end);
    expect(adjusted.end - adjusted.start).toBeCloseTo(MIN_LOOP_SECONDS, 6);
  });

  it('keeps the region ordered when the end is dragged past the start', () => {
    const adjusted = adjustLoopEdge(loop, 'end', 2, 100);
    expect(adjusted.end - adjusted.start).toBeCloseTo(MIN_LOOP_SECONDS, 6);
  });

  it('clamps to the track bounds', () => {
    expect(adjustLoopEdge(loop, 'start', -5, 100).start).toBe(0);
    expect(adjustLoopEdge(loop, 'end', 500, 100).end).toBe(100);
  });
});

describe('moveLoop', () => {
  it('slides without changing length', () => {
    const moved = moveLoop({ start: 10, end: 20 }, 5, 100);
    expect(moved).toEqual({ start: 15, end: 25 });
  });

  it('stops at the start of the track', () => {
    expect(moveLoop({ start: 10, end: 20 }, -50, 100)).toEqual({ start: 0, end: 10 });
  });

  it('stops at the end of the track', () => {
    expect(moveLoop({ start: 10, end: 20 }, 500, 100)).toEqual({ start: 90, end: 100 });
  });
});

describe('snapLoopToBeats', () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3];

  it('snaps edges that are already close to a beat', () => {
    expect(snapLoopToBeats({ start: 0.52, end: 2.03 }, beats)).toEqual({ start: 0.5, end: 2 });
  });

  it('leaves a deliberately off-grid selection alone', () => {
    const loop = { start: 0.75, end: 2.25 };
    expect(snapLoopToBeats(loop, beats, 0.05)).toEqual(loop);
  });

  it('does nothing without a beat grid', () => {
    const loop = { start: 0.52, end: 2.03 };
    expect(snapLoopToBeats(loop, [])).toEqual(loop);
  });

  it('refuses a snap that would collapse the region', () => {
    const loop = { start: 0.99, end: 1.01 };
    expect(snapLoopToBeats(loop, beats, 0.2)).toEqual(loop);
  });
});

describe('extendToBars', () => {
  it('rounds up to a whole number of bars', () => {
    // 120 BPM, 4/4 => 2 s per bar.
    const extended = extendToBars({ start: 0, end: 3.4 }, 120, 4, 100);
    expect(extended.end).toBeCloseTo(4, 6);
  });

  it('rounds down when that is nearer', () => {
    const extended = extendToBars({ start: 0, end: 4.2 }, 120, 4, 100);
    expect(extended.end).toBeCloseTo(4, 6);
  });

  it('never produces zero bars', () => {
    const extended = extendToBars({ start: 0, end: 0.2 }, 120, 4, 100);
    expect(extended.end).toBeCloseTo(2, 6);
  });

  it('clamps to the end of the track', () => {
    expect(extendToBars({ start: 0, end: 9 }, 120, 4, 5).end).toBe(5);
  });

  it('does nothing without a tempo', () => {
    const loop = { start: 0, end: 3.4 };
    expect(extendToBars(loop, null)).toEqual(loop);
    expect(extendToBars(loop, 0)).toEqual(loop);
  });

  it('honours a different time signature', () => {
    const extended = extendToBars({ start: 0, end: 1.4 }, 120, 3, 100);
    expect(extended.end).toBeCloseTo(1.5, 6);
  });
});
