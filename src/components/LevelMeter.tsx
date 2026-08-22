import {
  dbToMeterPosition,
  isClipping,
  type MeterState,
  meterZone,
} from '../audio/meters';

interface LevelMeterProps {
  state: MeterState;
  now: number;
  label?: string;
}

/**
 * A horizontal level meter with a held peak marker and a clip light.
 *
 * The clip light stays lit for a couple of seconds after an over, because
 * an indicator that flashes for one frame is an indicator nobody sees.
 */
export function LevelMeter({ state, now, label }: LevelMeterProps): JSX.Element {
  const fill = dbToMeterPosition(state.levelDb);
  const peak = dbToMeterPosition(state.peakDb);
  const zone = meterZone(state.levelDb);
  const clipping = isClipping(state, now);

  return (
    <div
      className="meter"
      role="meter"
      aria-label={label ? `${label} level` : 'Level'}
      aria-valuenow={Math.round(state.levelDb)}
      aria-valuemin={-60}
      aria-valuemax={6}
      title={`${state.levelDb.toFixed(1)} dB (peak ${state.peakDb.toFixed(1)} dB)`}
    >
      <div className="meter__track">
        <div
          className={`meter__fill${zone === 'safe' ? '' : ` is-${zone}`}`}
          style={{ width: `${fill * 100}%` }}
        />
        {state.peakDb > -59 ? (
          <div className="meter__peak" style={{ left: `calc(${peak * 100}% - 1px)` }} />
        ) : null}
      </div>
      <div className={`meter__clip${clipping ? ' is-lit' : ''}`} title={clipping ? 'Clipped' : 'No clipping'} />
    </div>
  );
}

export default LevelMeter;
