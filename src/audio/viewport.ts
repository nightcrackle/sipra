/**
 * Waveform viewport maths: zoom, scroll, and the mapping between time and
 * pixels.
 *
 * Every lane shares one viewport, which is what keeps them aligned. All of
 * it is pure arithmetic so the awkward cases — zooming past the end,
 * scrolling before zero, a zero-width canvas during layout — can be tested
 * rather than found by dragging.
 */

export const MIN_VISIBLE_SECONDS = 0.02;
export const DEFAULT_MAX_ZOOM = 4000;

export interface Viewport {
  /** Left edge of the visible window, in seconds. */
  start: number;
  /** Width of the visible window, in seconds. */
  duration: number;
  /** Full length of the track, in seconds. */
  total: number;
}

export function createViewport(total: number): Viewport {
  const length = Number.isFinite(total) && total > 0 ? total : 0;
  return { start: 0, duration: length, total: length };
}

/**
 * Keep a viewport inside the track.
 *
 * A window can never be longer than the track or shorter than
 * `MIN_VISIBLE_SECONDS`, and it always sits fully within `[0, total]`, so
 * no amount of scrolling can leave the user staring at empty space.
 */
export function clampViewport(viewport: Viewport): Viewport {
  const total = Math.max(0, viewport.total);
  if (total <= 0) return { start: 0, duration: 0, total: 0 };

  const duration = Math.min(total, Math.max(MIN_VISIBLE_SECONDS, viewport.duration));
  const start = Math.min(Math.max(0, viewport.start), Math.max(0, total - duration));
  return { start, duration, total };
}

export function viewportEnd(viewport: Viewport): number {
  return viewport.start + viewport.duration;
}

export function zoomLevel(viewport: Viewport): number {
  if (viewport.duration <= 0) return 1;
  return viewport.total / viewport.duration;
}

/**
 * Zoom by a factor, holding `anchorSeconds` still.
 *
 * Anchoring on the cursor is what makes wheel-zoom feel right: the sample
 * under the pointer stays under the pointer.
 */
export function zoomAt(
  viewport: Viewport,
  factor: number,
  anchorSeconds: number,
  maxZoom: number = DEFAULT_MAX_ZOOM,
): Viewport {
  if (!Number.isFinite(factor) || factor <= 0) return viewport;
  const total = viewport.total;
  if (total <= 0) return viewport;

  const minDuration = Math.max(MIN_VISIBLE_SECONDS, total / maxZoom);
  const duration = Math.min(total, Math.max(minDuration, viewport.duration / factor));

  const anchor = Math.min(Math.max(anchorSeconds, viewport.start), viewportEnd(viewport));
  const anchorRatio = viewport.duration > 0 ? (anchor - viewport.start) / viewport.duration : 0.5;

  return clampViewport({
    start: anchor - anchorRatio * duration,
    duration,
    total,
  });
}

export function zoomToFit(viewport: Viewport): Viewport {
  return clampViewport({ start: 0, duration: viewport.total, total: viewport.total });
}

/** Frame a time range with a little breathing room on each side. */
export function zoomToRange(
  viewport: Viewport,
  fromSeconds: number,
  toSeconds: number,
  paddingRatio = 0.05,
): Viewport {
  const low = Math.min(fromSeconds, toSeconds);
  const high = Math.max(fromSeconds, toSeconds);
  const span = Math.max(MIN_VISIBLE_SECONDS, high - low);
  const padding = span * paddingRatio;
  return clampViewport({
    start: low - padding,
    duration: span + padding * 2,
    total: viewport.total,
  });
}

export function scrollBy(viewport: Viewport, deltaSeconds: number): Viewport {
  return clampViewport({ ...viewport, start: viewport.start + deltaSeconds });
}

/** Scroll by a fraction of the visible window — one wheel notch. */
export function scrollByPage(viewport: Viewport, pages: number): Viewport {
  return scrollBy(viewport, viewport.duration * pages);
}

/**
 * Scroll so `seconds` is visible, doing nothing if it already is.
 *
 * Once the playhead runs off the right edge the window jumps forward by
 * most of a page, so playback does not cause a scroll on every frame.
 */
export function scrollToReveal(viewport: Viewport, seconds: number, margin = 0.1): Viewport {
  const end = viewportEnd(viewport);
  const marginSeconds = viewport.duration * margin;
  if (seconds >= viewport.start + marginSeconds && seconds <= end - marginSeconds) {
    return viewport;
  }
  if (seconds < viewport.start + marginSeconds) {
    return clampViewport({ ...viewport, start: seconds - marginSeconds });
  }
  return clampViewport({ ...viewport, start: seconds - viewport.duration * (1 - margin) });
}

/** Keep the playhead centred, for follow-playback mode. */
export function centreOn(viewport: Viewport, seconds: number): Viewport {
  return clampViewport({ ...viewport, start: seconds - viewport.duration / 2 });
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------

export function timeToX(viewport: Viewport, seconds: number, width: number): number {
  if (viewport.duration <= 0 || width <= 0) return 0;
  return ((seconds - viewport.start) / viewport.duration) * width;
}

export function xToTime(viewport: Viewport, x: number, width: number): number {
  if (width <= 0) return viewport.start;
  return viewport.start + (x / width) * viewport.duration;
}

/** Seconds represented by one pixel — used to pick a peak resolution. */
export function secondsPerPixel(viewport: Viewport, width: number): number {
  if (width <= 0) return viewport.duration;
  return viewport.duration / width;
}

/**
 * Whether the precomputed envelope still has enough detail.
 *
 * Below one bucket per pixel the stored envelope starts inventing a
 * flat-looking waveform, so the lane switches to reading decoded samples.
 */
export function needsSampleAccuracy(
  viewport: Viewport,
  width: number,
  sampleRate: number,
  samplesPerBucket: number,
): boolean {
  if (width <= 0 || sampleRate <= 0 || samplesPerBucket <= 0) return false;
  const bucketsPerPixel = (secondsPerPixel(viewport, width) * sampleRate) / samplesPerBucket;
  return bucketsPerPixel < 1;
}

// ---------------------------------------------------------------------------
// Time ruler
// ---------------------------------------------------------------------------

const TICK_STEPS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
];

/**
 * Pick a tick interval giving roughly `targetTicks` labels.
 *
 * Snapping to a musically sensible set keeps the ruler on round numbers
 * instead of showing marks every 3.7 seconds.
 */
export function chooseTickInterval(visibleSeconds: number, targetTicks = 8): number {
  if (!Number.isFinite(visibleSeconds) || visibleSeconds <= 0) return 1;
  const ideal = visibleSeconds / Math.max(1, targetTicks);
  for (const step of TICK_STEPS) {
    if (step >= ideal) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1] ?? 1800;
}

/** Tick positions in seconds across the visible window. */
export function tickPositions(viewport: Viewport, targetTicks = 8): number[] {
  const interval = chooseTickInterval(viewport.duration, targetTicks);
  const first = Math.ceil(viewport.start / interval) * interval;
  const end = viewportEnd(viewport);
  const ticks: number[] = [];
  // The loop is bounded so a pathological interval cannot hang the frame.
  for (let time = first; time <= end && ticks.length < 512; time += interval) {
    ticks.push(Number(time.toFixed(6)));
  }
  return ticks;
}
