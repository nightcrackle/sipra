import { useEffect, useRef } from 'react';

import { decimatePeaks, type PeakData, peaksFromChannels } from '@shared/peaks';

import { needsSampleAccuracy, type Viewport } from '../audio/viewport';

interface WaveformCanvasProps {
  peaks: PeakData | null;
  /** Decoded audio, used when zoomed past the envelope's resolution. */
  channels: Float32Array[] | null;
  sampleRate: number;
  viewport: Viewport;
  color: string;
  height: number;
  dimmed?: boolean;
}

/**
 * One lane's waveform.
 *
 * Drawn on a canvas rather than as SVG: at typical widths a lane is
 * 1200-plus min/max pairs, and six lanes of that many DOM nodes makes
 * scrolling crawl.
 *
 * Two sources of shape, chosen by zoom level. The precomputed envelope
 * covers everything up to about one bucket per pixel; past that the lane
 * reads decoded samples directly, so zooming right in shows the actual
 * waveform instead of a smooth invention.
 */
export function WaveformCanvas({
  peaks,
  channels,
  sampleRate,
  viewport,
  color,
  height,
  dimmed = false,
}: WaveformCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = (): void => {
      const cssWidth = parent.clientWidth;
      const cssHeight = height;
      if (cssWidth <= 0 || cssHeight <= 0) return;

      // Match the backing store to the display so lines stay crisp on a
      // scaled display instead of blurring.
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssWidth * ratio)) {
        canvas.width = Math.round(cssWidth * ratio);
      }
      if (canvas.height !== Math.round(cssHeight * ratio)) {
        canvas.height = Math.round(cssHeight * ratio);
      }

      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);

      const midline = cssHeight / 2;

      context.strokeStyle = 'rgba(255,255,255,0.07)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, Math.round(midline) + 0.5);
      context.lineTo(cssWidth, Math.round(midline) + 0.5);
      context.stroke();

      const columns = Math.max(1, Math.floor(cssWidth));
      let envelope: { min: Float32Array; max: Float32Array } | null = null;

      const zoomedPastEnvelope =
        peaks !== null &&
        needsSampleAccuracy(viewport, cssWidth, peaks.sampleRate, peaks.samplesPerBucket);

      if (zoomedPastEnvelope && channels && channels.length > 0) {
        envelope = peaksFromChannels(
          channels,
          sampleRate,
          viewport.start * sampleRate,
          (viewport.start + viewport.duration) * sampleRate,
          columns,
        );
      } else if (peaks) {
        envelope = decimatePeaks(
          peaks,
          viewport.start,
          viewport.start + viewport.duration,
          columns,
        );
      }

      if (!envelope) return;

      context.globalAlpha = dimmed ? 0.45 : 1;
      context.fillStyle = color;

      // One rectangle per column, at least a pixel tall so quiet passages
      // still read as a line rather than vanishing.
      for (let column = 0; column < columns; column += 1) {
        const low = envelope.min[column] ?? 0;
        const high = envelope.max[column] ?? 0;
        const top = midline - high * midline * 0.94;
        const bottom = midline - low * midline * 0.94;
        const barHeight = Math.max(1, bottom - top);
        context.fillRect(column, top, 1, barHeight);
      }

      context.globalAlpha = 1;
    };

    draw();

    const observer = new ResizeObserver(() => draw());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [peaks, channels, sampleRate, viewport, color, height, dimmed]);

  return <canvas ref={canvasRef} className="lane__canvas" aria-hidden="true" />;
}

export default WaveformCanvas;
