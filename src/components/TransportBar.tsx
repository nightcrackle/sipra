import { formatTime } from '@shared/format';
import { clampGainDb } from '@shared/mix';

import type { MeterState } from '../audio/meters';
import { LevelMeter } from './LevelMeter';
import {
  LoopIcon,
  PauseIcon,
  PlayIcon,
  SkipStartIcon,
  StopIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './Icons';

interface TransportBarProps {
  playing: boolean;
  position: number;
  duration: number;
  loopEnabled: boolean;
  hasLoop: boolean;
  followPlayhead: boolean;
  referenceOriginal: boolean;
  hasOriginal: boolean;
  backingBusDb: number | null;
  masterGainDb: number;
  masterMeter: MeterState;
  now: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onSkipStart: () => void;
  onToggleLoop: () => void;
  onClearLoop: () => void;
  onToggleFollow: () => void;
  onToggleReference: (active: boolean) => void;
  onBackingChange: (db: number | null) => void;
  onMasterChange: (db: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onZoomLoop: () => void;
}

export function TransportBar(props: TransportBarProps): JSX.Element {
  const {
    playing,
    position,
    duration,
    loopEnabled,
    hasLoop,
    followPlayhead,
    referenceOriginal,
    hasOriginal,
    backingBusDb,
    masterGainDb,
    masterMeter,
    now,
  } = props;

  return (
    <div className="transport">
      <div className="transport__group">
        <button
          type="button"
          className="btn btn--icon"
          onClick={props.onSkipStart}
          title="Back to start (Home)"
          aria-label="Back to start"
        >
          <SkipStartIcon size={16} />
        </button>
        <button
          type="button"
          className="transport__play"
          onClick={props.onTogglePlay}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={props.onStop}
          title="Stop"
          aria-label="Stop"
        >
          <StopIcon size={14} />
        </button>
      </div>

      <div className="transport__time tabular">
        {formatTime(position, { millis: true })}
        <span> / {formatTime(duration)}</span>
      </div>

      <div className="transport__divider" />

      <div className="transport__group">
        <button
          type="button"
          className={`btn btn--icon${loopEnabled ? ' is-active' : ''}`}
          onClick={props.onToggleLoop}
          disabled={!hasLoop}
          title={hasLoop ? 'Loop the selected region (L)' : 'Drag across a lane to mark a loop'}
          aria-pressed={loopEnabled}
        >
          <LoopIcon size={16} />
        </button>
        {hasLoop ? (
          <button type="button" className="btn btn--sm" onClick={props.onClearLoop}>
            Clear loop
          </button>
        ) : null}
      </div>

      <div className="transport__divider" />

      <div className="transport__group">
        <button
          type="button"
          className="btn btn--icon"
          onClick={props.onZoomOut}
          title="Zoom out (−)"
          aria-label="Zoom out"
        >
          <ZoomOutIcon size={16} />
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={props.onZoomIn}
          title="Zoom in (+)"
          aria-label="Zoom in"
        >
          <ZoomInIcon size={16} />
        </button>
        <button type="button" className="btn btn--sm" onClick={props.onZoomFit} title="Fit the whole track (0)">
          Fit
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={props.onZoomLoop}
          disabled={!hasLoop}
          title="Zoom to the loop region"
        >
          Loop
        </button>
        <button
          type="button"
          className={`btn btn--sm${followPlayhead ? ' is-active' : ''}`}
          onClick={props.onToggleFollow}
          title="Scroll the view to keep the playhead visible"
          aria-pressed={followPlayhead}
        >
          Follow
        </button>
      </div>

      <div className="transport__divider" />

      {/*
        Holding the button auditions the original mix, so A/B is a
        momentary comparison rather than a toggle you forget you left on.
      */}
      <button
        type="button"
        className={`btn${referenceOriginal ? ' is-active' : ''}`}
        disabled={!hasOriginal}
        onPointerDown={() => props.onToggleReference(true)}
        onPointerUp={() => props.onToggleReference(false)}
        onPointerLeave={() => referenceOriginal && props.onToggleReference(false)}
        title="Hold to hear the original mix (or press O)"
      >
        Original
      </button>

      <div className="transport__group" title="Level of the stems you have not selected">
        <span className="muted" style={{ fontSize: 12 }}>
          Backing
        </span>
        <input
          type="range"
          min={-40}
          max={0}
          step={0.5}
          value={backingBusDb ?? -40}
          onChange={(event) => {
            const value = Number(event.target.value);
            props.onBackingChange(value <= -40 ? null : value);
          }}
          style={{ width: 88, accentColor: 'var(--brand)' }}
          aria-label="Backing track level"
        />
        <span className="lane__db tabular">
          {backingBusDb === null ? 'off' : `${backingBusDb.toFixed(1)} dB`}
        </span>
      </div>

      <div className="grow" />

      <div className="transport__master">
        <span className="muted" style={{ fontSize: 12 }}>
          Master
        </span>
        <input
          type="range"
          min={-40}
          max={6}
          step={0.5}
          value={clampGainDb(masterGainDb)}
          onChange={(event) => props.onMasterChange(Number(event.target.value))}
          aria-label="Master level"
        />
        <span className="lane__db tabular">{masterGainDb.toFixed(1)} dB</span>
      </div>

      <div style={{ width: 116 }}>
        <LevelMeter state={masterMeter} now={now} label="Master" />
      </div>
    </div>
  );
}

export default TransportBar;
