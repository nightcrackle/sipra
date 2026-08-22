import { describe, expect, it } from 'vitest';

import {
  centreOn,
  chooseTickInterval,
  clampViewport,
  createViewport,
  MIN_VISIBLE_SECONDS,
  needsSampleAccuracy,
  scrollBy,
  scrollByPage,
  scrollToReveal,
  secondsPerPixel,
  tickPositions,
  timeToX,
  type Viewport,
  viewportEnd,
  xToTime,
  zoomAt,
  zoomLevel,
  zoomToFit,
  zoomToRange,
} from '../src/audio/viewport';

const view = (start: number, duration: number, total = 200): Viewport => ({
  start,
  duration,
  total,
});

describe('createViewport', () => {
  it('starts showing the whole track', () => {
    expect(createViewport(120)).toEqual({ start: 0, duration: 120, total: 120 });
  });

  it('copes with a zero or invalid length', () => {
    expect(createViewport(0).total).toBe(0);
    expect(createViewport(Number.NaN).total).toBe(0);
    expect(createViewport(-5).total).toBe(0);
  });
});

describe('clampViewport', () => {
  it('never shows more than the track', () => {
    expect(clampViewport(view(0, 500)).duration).toBe(200);
  });

  it('never shows less than the minimum window', () => {
    expect(clampViewport(view(0, 0.0001)).duration).toBe(MIN_VISIBLE_SECONDS);
  });

  it('never scrolls before zero', () => {
    expect(clampViewport(view(-50, 60)).start).toBe(0);
  });

  it('never scrolls past the end', () => {
    // Otherwise the user ends up staring at empty space.
    const clamped = clampViewport(view(190, 60));
    expect(viewportEnd(clamped)).toBeLessThanOrEqual(200.0001);
  });

  it('collapses an empty track', () => {
    expect(clampViewport(view(10, 10, 0))).toEqual({ start: 0, duration: 0, total: 0 });
  });
});

describe('zoomAt', () => {
  it('halves the window when zooming in by two', () => {
    expect(zoomAt(view(0, 200), 2, 100).duration).toBeCloseTo(100, 6);
  });

  it('keeps the anchor point under the cursor', () => {
    // This is what makes wheel-zoom feel right.
    const before = view(0, 200);
    const anchor = 50;
    const after = zoomAt(before, 2, anchor);
    const ratioBefore = (anchor - before.start) / before.duration;
    const ratioAfter = (anchor - after.start) / after.duration;
    expect(ratioAfter).toBeCloseTo(ratioBefore, 6);
  });

  it('will not zoom out past the whole track', () => {
    expect(zoomAt(view(0, 200), 0.1, 100).duration).toBe(200);
  });

  it('respects the maximum zoom', () => {
    const zoomed = zoomAt(view(0, 200), 100000, 100, 1000);
    expect(zoomLevel(zoomed)).toBeLessThanOrEqual(1000.0001);
  });

  it('stays inside the track when anchored near an edge', () => {
    const zoomed = zoomAt(view(0, 200), 8, 0);
    expect(zoomed.start).toBeGreaterThanOrEqual(0);
    expect(viewportEnd(zoomed)).toBeLessThanOrEqual(200.0001);
  });

  it('ignores a nonsense factor', () => {
    expect(zoomAt(view(0, 200), 0, 100)).toEqual(view(0, 200));
    expect(zoomAt(view(0, 200), Number.NaN, 100)).toEqual(view(0, 200));
  });

  it('does nothing on an empty track', () => {
    const empty = view(0, 0, 0);
    expect(zoomAt(empty, 2, 0)).toEqual(empty);
  });
});

describe('zoomToFit and zoomToRange', () => {
  it('fits the whole track', () => {
    expect(zoomToFit(view(40, 20))).toEqual({ start: 0, duration: 200, total: 200 });
  });

  it('frames a range with a little padding', () => {
    const framed = zoomToRange(view(0, 200), 50, 60);
    expect(framed.start).toBeLessThan(50);
    expect(viewportEnd(framed)).toBeGreaterThan(60);
    expect(framed.duration).toBeGreaterThan(10);
  });

  it('accepts a reversed range', () => {
    const framed = zoomToRange(view(0, 200), 60, 50);
    expect(framed.start).toBeLessThan(50);
  });

  it('handles a zero-length range', () => {
    expect(zoomToRange(view(0, 200), 50, 50).duration).toBeGreaterThanOrEqual(MIN_VISIBLE_SECONDS);
  });
});

describe('scrolling', () => {
  it('scrolls by an offset', () => {
    expect(scrollBy(view(50, 20), 10).start).toBe(60);
  });

  it('clamps a scroll past the ends', () => {
    expect(scrollBy(view(50, 20), -100).start).toBe(0);
    expect(scrollBy(view(50, 20), 1000).start).toBe(180);
  });

  it('scrolls by a fraction of a page', () => {
    expect(scrollByPage(view(50, 20), 0.5).start).toBe(60);
  });

  it('leaves the window alone when the target is comfortably visible', () => {
    const before = view(50, 20);
    expect(scrollToReveal(before, 60)).toBe(before);
  });

  it('scrolls forward when the target has run off the right edge', () => {
    const after = scrollToReveal(view(50, 20), 75);
    expect(after.start).toBeGreaterThan(50);
    expect(viewportEnd(after)).toBeGreaterThanOrEqual(75);
  });

  it('scrolls back when the target is behind the window', () => {
    const after = scrollToReveal(view(50, 20), 10);
    expect(after.start).toBeLessThan(50);
  });

  it('jumps most of a page so playback does not scroll every frame', () => {
    const after = scrollToReveal(view(0, 20), 21);
    expect(after.start).toBeGreaterThan(2);
  });

  it('centres on a position', () => {
    expect(centreOn(view(0, 20), 100).start).toBeCloseTo(90, 6);
  });

  it('clamps a centre near the start', () => {
    expect(centreOn(view(0, 20), 2).start).toBe(0);
  });
});

describe('coordinate conversion', () => {
  it('maps time to pixels', () => {
    expect(timeToX(view(0, 100), 50, 1000)).toBe(500);
  });

  it('accounts for scroll', () => {
    expect(timeToX(view(50, 50), 75, 1000)).toBe(500);
  });

  it('maps pixels back to time', () => {
    expect(xToTime(view(0, 100), 500, 1000)).toBe(50);
  });

  it('round-trips', () => {
    const viewport = view(23, 41);
    expect(xToTime(viewport, timeToX(viewport, 40, 800), 800)).toBeCloseTo(40, 6);
  });

  it('survives a zero width during layout', () => {
    expect(timeToX(view(0, 100), 50, 0)).toBe(0);
    expect(xToTime(view(10, 100), 50, 0)).toBe(10);
  });

  it('reports seconds per pixel', () => {
    expect(secondsPerPixel(view(0, 100), 1000)).toBeCloseTo(0.1, 6);
  });
});

describe('needsSampleAccuracy', () => {
  it('is false when the envelope still has more than a bucket per pixel', () => {
    expect(needsSampleAccuracy(view(0, 200), 1000, 44100, 256)).toBe(false);
  });

  it('is true once zoomed past the envelope resolution', () => {
    // Past this point the stored envelope invents a flat waveform.
    expect(needsSampleAccuracy(view(0, 0.5), 1000, 44100, 256)).toBe(true);
  });

  it('is false for degenerate inputs', () => {
    expect(needsSampleAccuracy(view(0, 10), 0, 44100, 256)).toBe(false);
    expect(needsSampleAccuracy(view(0, 10), 100, 0, 256)).toBe(false);
    expect(needsSampleAccuracy(view(0, 10), 100, 44100, 0)).toBe(false);
  });
});

describe('time ruler ticks', () => {
  it('picks a round interval', () => {
    expect([1, 2, 5, 10, 15, 30]).toContain(chooseTickInterval(60, 8));
  });

  it('scales down when zoomed in', () => {
    expect(chooseTickInterval(0.5, 8)).toBeLessThanOrEqual(0.1);
  });

  it('scales up for a long view', () => {
    expect(chooseTickInterval(7200, 8)).toBeGreaterThanOrEqual(600);
  });

  it('copes with nonsense', () => {
    expect(chooseTickInterval(0)).toBe(1);
    expect(chooseTickInterval(Number.NaN)).toBe(1);
  });

  it('places ticks inside the visible window', () => {
    const ticks = tickPositions(view(10, 20));
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(10);
      expect(tick).toBeLessThanOrEqual(30.0001);
    }
  });

  it('spaces ticks evenly', () => {
    const ticks = tickPositions(view(0, 60));
    const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6);
  });

  it('is bounded so a pathological interval cannot hang a frame', () => {
    expect(tickPositions(view(0, 1e9, 1e9), 1e6).length).toBeLessThanOrEqual(512);
  });
});
