import { useCallback, useRef } from 'react';

import { clampGainDb, dbToFader, faderToDb, type LaneState } from '@shared/mix';
import type { PeakData } from '@shared/peaks';
import { STEM_BY_ID, type StemId, stemColor, stemLabel } from '@shared/stems';

import type { MeterState } from '../audio/meters';
import type { LoopRegion } from '../audio/loop';
import { timeToX, type Viewport, xToTime } from '../audio/viewport';
import { LevelMeter } from './LevelMeter';
import { WaveformCanvas } from './WaveformCanvas';

interface StemLaneProps {
  lane: LaneState;
  peaks: PeakData | null;
  channels: Float32Array[] | null;
  sampleRate: number;
  viewport: Viewport;
  loop: LoopRegion | null;
  position: number;
  meter: MeterState;
  now: number;
  anySolo: boolean;
  onToggleMute: (stemId: StemId) => void;
  onToggleSolo: (stemId: StemId) => void;
  onToggleSelect: (stemId: StemId) => void;
  onGainChange: (stemId: StemId, gainDb: number) => void;
  onSeek: (seconds: number) => void;
  onLoopDrag: (anchorSeconds: number, cursorSeconds: number, committed: boolean) => void;
}

const LANE_HEIGHT = 92;

export function StemLane({
  lane,
  peaks,
  channels,
  sampleRate,
  viewport,
  loop,
  position,
  meter,
  now,
  anySolo,
  onToggleMute,
  onToggleSolo,
  onToggleSelect,
  onGainChange,
  onSeek,
  onLoopDrag,
}: StemLaneProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragAnchor = useRef<number | null>(null);

  const definition = STEM_BY_ID[lane.stemId];
  const colour = stemColor(lane.stemId);
  const silenced = lane.muted || (anySolo && !lane.solo);

  const timeAtEvent = useCallback(
    (clientX: number): number => {
      const element = wrapRef.current;
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      return xToTime(viewport, clientX - rect.left, rect.width);
    },
    [viewport],
  );

  /**
   * Click seeks; drag marks a loop.
   *
   * Which one it was is decided on pointer-up by how far the pointer
   * moved, so a slightly shaky click still seeks instead of creating a
   * 20 ms loop.
   */
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const element = wrapRef.current;
    if (!element) return;
    element.setPointerCapture(event.pointerId);
    dragAnchor.current = timeAtEvent(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragAnchor.current === null) return;
    onLoopDrag(dragAnchor.current, timeAtEvent(event.clientX), false);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const anchor = dragAnchor.current;
    dragAnchor.current = null;
    const element = wrapRef.current;
    if (element?.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    if (anchor === null) return;
    const cursor = timeAtEvent(event.clientX);
    onLoopDrag(anchor, cursor, true);
    if (Math.abs(cursor - anchor) < viewport.duration * 0.004) onSeek(anchor);
  };

  const width = wrapRef.current?.clientWidth ?? 0;
  const playheadX = timeToX(viewport, position, width);
  const loopLeft = loop ? timeToX(viewport, loop.start, width) : 0;
  const loopRight = loop ? timeToX(viewport, loop.end, width) : 0;

  return (
    <div
      className={`lane${lane.selected ? '' : ' is-unselected'}${silenced ? ' is-muted' : ''}`}
    >
      <div className="lane__controls">
        <div className="lane__top">
          <span className="lane__swatch" style={{ background: colour }} />
          <span className="lane__name">{stemLabel(lane.stemId)}</span>
          {definition?.experimental ? (
            <span className="lane__flag" title={definition.note}>
              EXP
            </span>
          ) : null}
        </div>

        <div className="lane__buttons">
          <button
            type="button"
            className={`lane-btn${lane.muted ? ' is-on' : ''}`}
            onClick={() => onToggleMute(lane.stemId)}
            title="Mute"
            aria-pressed={lane.muted}
          >
            M
          </button>
          <button
            type="button"
            className={`lane-btn is-solo${lane.solo ? ' is-on' : ''}`}
            onClick={() => onToggleSolo(lane.stemId)}
            title="Solo"
            aria-pressed={lane.solo}
          >
            S
          </button>
          <button
            type="button"
            className={`lane-btn${lane.selected ? ' is-on' : ''}`}
            onClick={() => onToggleSelect(lane.stemId)}
            title={
              lane.selected
                ? 'In your selection. Click to move it to the backing track.'
                : 'In the backing track. Click to bring it into your selection.'
            }
            aria-pressed={lane.selected}
          >
            ✓
          </button>
          <div className="grow" />
        </div>

        <div className="lane__fader-row">
          <input
            className="lane__fader"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={dbToFader(lane.gainDb)}
            onChange={(event) => onGainChange(lane.stemId, faderToDb(Number(event.target.value)))}
            onDoubleClick={() => onGainChange(lane.stemId, 0)}
            aria-label={`${stemLabel(lane.stemId)} level`}
            title="Double-click to reset to 0 dB"
          />
          <span className="lane__db tabular">
            {clampGainDb(lane.gainDb) <= -60 ? '−∞' : `${lane.gainDb > 0 ? '+' : ''}${lane.gainDb.toFixed(1)}`}
            {' dB'}
          </span>
        </div>

        <LevelMeter state={meter} now={now} label={stemLabel(lane.stemId)} />
      </div>

      <div
        className="lane__canvas-wrap"
        ref={wrapRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ height: LANE_HEIGHT }}
      >
        <WaveformCanvas
          peaks={peaks}
          channels={channels}
          sampleRate={sampleRate}
          viewport={viewport}
          color={colour}
          height={LANE_HEIGHT}
          dimmed={!lane.selected || silenced}
        />
        {loop && loopRight > loopLeft ? (
          <div
            className="lane__loop-shade"
            style={{ left: loopLeft, width: Math.max(1, loopRight - loopLeft) }}
          />
        ) : null}
        {playheadX >= 0 && playheadX <= width ? (
          <div className="lane__playhead" style={{ left: playheadX }} />
        ) : null}
      </div>
    </div>
  );
}

export default StemLane;
