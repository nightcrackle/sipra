import { useRef } from 'react';

import { formatTime } from '@shared/format';

import type { LoopRegion } from '../audio/loop';
import { timeToX, tickPositions, type Viewport, xToTime } from '../audio/viewport';

interface TimeRulerProps {
  viewport: Viewport;
  loop: LoopRegion | null;
  onSeek: (seconds: number) => void;
}

export function TimeRuler({ viewport, loop, onSeek }: TimeRulerProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const width = ref.current?.clientWidth ?? 0;

  // Below a couple of seconds on screen, whole seconds are useless labels.
  const showMillis = viewport.duration < 4;
  const ticks = tickPositions(viewport, Math.max(4, Math.floor(width / 110)));

  return (
    <div
      className="ruler"
      ref={ref}
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSeek(xToTime(viewport, event.clientX - rect.left, rect.width));
      }}
      role="presentation"
    >
      {loop ? (
        <div
          className="ruler__loop"
          style={{
            left: timeToX(viewport, loop.start, width),
            width: Math.max(
              1,
              timeToX(viewport, loop.end, width) - timeToX(viewport, loop.start, width),
            ),
          }}
        />
      ) : null}

      {ticks.map((tick) => (
        <div key={tick} className="ruler__tick" style={{ left: timeToX(viewport, tick, width) }}>
          {formatTime(tick, { millis: showMillis })}
        </div>
      ))}
    </div>
  );
}

export default TimeRuler;
