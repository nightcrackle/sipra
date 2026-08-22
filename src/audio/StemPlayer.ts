/**
 * Multi-stem playback engine.
 *
 * Every stem is its own `AudioBufferSourceNode`, and they are all started
 * at the same scheduled context time with the same offset. That is what
 * keeps six lanes sample-locked: nothing is started "now", because "now"
 * drifts by a buffer between the first call and the sixth.
 *
 * Looping uses the source nodes' own `loop`/`loopStart`/`loopEnd`, so the
 * wrap happens on the audio thread. Restarting sources from a JavaScript
 * timer would put a gap at every loop point.
 *
 * Graph, per stem:
 *
 *     source -> gain -> analyser -> master -> destination
 */

import type { StemId } from '@shared/stems';

import { createMeterState, type MeterState, updateMeter } from './meters';
import type { LoopRegion } from './loop';

/** Scheduling lead so every source starts on the same block boundary. */
const START_LEAD_SECONDS = 0.06;

/** Gain ramp time. Long enough to avoid a click, short enough to feel instant. */
const GAIN_RAMP_SECONDS = 0.015;

const ANALYSER_FFT_SIZE = 1024;

/**
 * The exact Float32Array flavour `getFloatTimeDomainData` accepts.
 *
 * Newer TypeScript DOM libs parameterise typed arrays by buffer kind, so a
 * plain `Float32Array` annotation stops type-checking. Deriving the type
 * from the method signature keeps this correct across lib versions.
 */
type TimeDomainBuffer = Parameters<AnalyserNode['getFloatTimeDomainData']>[0];

export const ORIGINAL_LANE = '__original__';
export type LaneKey = StemId | typeof ORIGINAL_LANE;

interface Lane {
  key: LaneKey;
  buffer: AudioBuffer;
  gain: GainNode;
  analyser: AnalyserNode;
  source: AudioBufferSourceNode | null;
  scratch: TimeDomainBuffer;
  meter: MeterState;
  targetGain: number;
}

export interface PlayerSnapshot {
  playing: boolean;
  position: number;
  duration: number;
  loop: LoopRegion | null;
  loopEnabled: boolean;
}

export type PlayerListener = (snapshot: PlayerSnapshot) => void;

export interface StemPlayerOptions {
  /** Injectable for tests; defaults to a real AudioContext. */
  createContext?: () => AudioContext;
}

export class StemPlayer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterScratch: TimeDomainBuffer = new Float32Array(ANALYSER_FFT_SIZE);
  private masterMeter: MeterState = createMeterState();

  private readonly lanes = new Map<LaneKey, Lane>();
  private readonly listeners = new Set<PlayerListener>();

  private playing = false;
  private startedAtContextTime = 0;
  private startOffset = 0;
  private duration = 0;
  private loopRegion: LoopRegion | null = null;
  private loopEnabled = false;
  private lastMeterTime = 0;
  private readonly createContext: () => AudioContext;

  constructor(options: StemPlayerOptions = {}) {
    this.createContext =
      options.createContext ??
      (() => new (window.AudioContext || (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)());
  }

  // -- lifecycle -------------------------------------------------------

  /**
   * Create the audio context.
   *
   * Browsers only allow this from a user gesture, so it is deliberately
   * not done in the constructor — the first click on Play creates it.
   */
  ensureContext(): AudioContext {
    if (this.context) return this.context;
    const context = this.createContext();
    const master = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    master.connect(analyser);
    analyser.connect(context.destination);

    this.context = context;
    this.master = master;
    this.masterAnalyser = analyser;
    this.masterScratch = new Float32Array(analyser.fftSize);
    return context;
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get durationSeconds(): number {
    return this.duration;
  }

  /** Decode an ArrayBuffer with this player's context. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const context = this.ensureContext();
    return context.decodeAudioData(data);
  }

  /**
   * Add or replace a lane's audio.
   *
   * Track duration is the longest lane, so a stem that decodes to a
   * slightly different length cannot shorten the timeline.
   */
  setLane(key: LaneKey, buffer: AudioBuffer): void {
    const context = this.ensureContext();
    const existing = this.lanes.get(key);
    if (existing) {
      this.stopSource(existing);
      existing.gain.disconnect();
      existing.analyser.disconnect();
    }

    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    gain.connect(analyser);
    if (this.master) analyser.connect(this.master);

    const previousGain = existing?.targetGain ?? 1;
    gain.gain.value = previousGain;

    this.lanes.set(key, {
      key,
      buffer,
      gain,
      analyser,
      source: null,
      scratch: new Float32Array(analyser.fftSize),
      meter: createMeterState(),
      targetGain: previousGain,
    });

    this.duration = Math.max(this.duration, buffer.duration);
    // A lane added mid-playback must join in sync rather than at zero.
    if (this.playing) this.startSources(this.position, this.context!.currentTime + START_LEAD_SECONDS);
    this.emit();
  }

  removeLane(key: LaneKey): void {
    const lane = this.lanes.get(key);
    if (!lane) return;
    this.stopSource(lane);
    lane.gain.disconnect();
    lane.analyser.disconnect();
    this.lanes.delete(key);
    this.duration = [...this.lanes.values()].reduce(
      (max, candidate) => Math.max(max, candidate.buffer.duration),
      0,
    );
    this.emit();
  }

  hasLane(key: LaneKey): boolean {
    return this.lanes.has(key);
  }

  get laneKeys(): LaneKey[] {
    return [...this.lanes.keys()];
  }

  // -- transport -------------------------------------------------------

  get position(): number {
    if (!this.playing || !this.context) return this.clampPosition(this.startOffset);
    const elapsed = this.context.currentTime - this.startedAtContextTime;
    const raw = this.startOffset + Math.max(0, elapsed);

    const loop = this.activeLoop();
    if (!loop) return this.clampPosition(raw);

    if (raw < loop.end) return this.clampPosition(raw);
    const span = loop.end - loop.start;
    if (span <= 0) return this.clampPosition(loop.start);
    return loop.start + ((raw - loop.end) % span);
  }

  async play(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    if (this.playing) return;
    if (this.lanes.size === 0) return;

    let from = this.clampPosition(this.startOffset);
    // Starting at the very end would produce silence; roll back to zero.
    if (from >= this.duration - 0.01) from = 0;

    const loop = this.activeLoop();
    if (loop && (from < loop.start || from >= loop.end)) from = loop.start;

    this.startSources(from, context.currentTime + START_LEAD_SECONDS);
    this.playing = true;
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    const at = this.position;
    for (const lane of this.lanes.values()) this.stopSource(lane);
    this.playing = false;
    this.startOffset = this.clampPosition(at);
    this.emit();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  stop(): void {
    for (const lane of this.lanes.values()) this.stopSource(lane);
    this.playing = false;
    this.startOffset = 0;
    this.emit();
  }

  /** Move the playhead, restarting sources if playing. */
  seek(seconds: number): void {
    const target = this.clampPosition(seconds);
    if (!this.playing || !this.context) {
      this.startOffset = target;
      this.emit();
      return;
    }
    for (const lane of this.lanes.values()) this.stopSource(lane);
    this.startSources(target, this.context.currentTime + START_LEAD_SECONDS);
    this.emit();
  }

  // -- looping ---------------------------------------------------------

  setLoop(region: LoopRegion | null, enabled = region !== null): void {
    this.loopRegion = region;
    this.loopEnabled = enabled && region !== null;
    this.applyLoopToSources();
    this.emit();
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled && this.loopRegion !== null;
    this.applyLoopToSources();
    this.emit();
  }

  get loop(): LoopRegion | null {
    return this.loopRegion;
  }

  get isLoopEnabled(): boolean {
    return this.loopEnabled;
  }

  private activeLoop(): LoopRegion | null {
    if (!this.loopEnabled || !this.loopRegion) return null;
    if (this.loopRegion.end - this.loopRegion.start <= 0) return null;
    return this.loopRegion;
  }

  /**
   * Push loop bounds onto the live sources.
   *
   * Editing a loop during playback has to take effect without restarting,
   * or dragging its edge would stutter on every mouse move.
   */
  private applyLoopToSources(): void {
    const loop = this.activeLoop();
    for (const lane of this.lanes.values()) {
      const source = lane.source;
      if (!source) continue;
      if (loop) {
        source.loopStart = loop.start;
        source.loopEnd = loop.end;
        source.loop = true;
      } else {
        source.loop = false;
      }
    }
  }

  // -- mixing ----------------------------------------------------------

  /**
   * Set a lane's linear gain, ramped to avoid a click.
   *
   * `setTargetAtTime` is deliberately not used: its exponential approach
   * never quite reaches zero, so a "muted" stem stays faintly audible.
   */
  setLaneGain(key: LaneKey, gain: number): void {
    const lane = this.lanes.get(key);
    if (!lane || !this.context) return;
    const value = Number.isFinite(gain) ? Math.max(0, gain) : 0;
    lane.targetGain = value;
    const now = this.context.currentTime;
    lane.gain.gain.cancelScheduledValues(now);
    lane.gain.gain.setValueAtTime(lane.gain.gain.value, now);
    lane.gain.gain.linearRampToValueAtTime(value, now + GAIN_RAMP_SECONDS);
  }

  /**
   * Apply a resolved mix to every lane.
   *
   * The original-mix lane is driven separately from the stems so that
   * A/B is a clean swap rather than a blend.
   */
  applyGains(gains: Record<string, number>, originalGain = 0): void {
    for (const key of this.lanes.keys()) {
      if (key === ORIGINAL_LANE) this.setLaneGain(key, originalGain);
      else this.setLaneGain(key, gains[key] ?? 0);
    }
  }

  setMasterGain(gain: number): void {
    if (!this.master || !this.context) return;
    const value = Number.isFinite(gain) ? Math.max(0, gain) : 0;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(value, now + GAIN_RAMP_SECONDS);
  }

  // -- metering --------------------------------------------------------

  /**
   * Read every analyser and advance the meter ballistics.
   *
   * Called once per animation frame. Returns the state for each lane plus
   * the master bus.
   */
  sampleMeters(
    now: number,
    mode: 'peak' | 'rms' = 'peak',
  ): { lanes: Map<LaneKey, MeterState>; master: MeterState } {
    const deltaSeconds = this.lastMeterTime === 0 ? 0 : Math.max(0, (now - this.lastMeterTime) / 1000);
    this.lastMeterTime = now;

    const result = new Map<LaneKey, MeterState>();
    for (const [key, lane] of this.lanes) {
      lane.analyser.getFloatTimeDomainData(lane.scratch);
      let peak = 0;
      let sumSquares = 0;
      for (let index = 0; index < lane.scratch.length; index += 1) {
        const value = lane.scratch[index] ?? 0;
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, lane.scratch.length));
      lane.meter = updateMeter(lane.meter, { peak, rms, now, deltaSeconds, mode });
      result.set(key, lane.meter);
    }

    if (this.masterAnalyser) {
      this.masterAnalyser.getFloatTimeDomainData(this.masterScratch);
      let peak = 0;
      let sumSquares = 0;
      for (let index = 0; index < this.masterScratch.length; index += 1) {
        const value = this.masterScratch[index] ?? 0;
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, this.masterScratch.length));
      this.masterMeter = updateMeter(this.masterMeter, { peak, rms, now, deltaSeconds, mode });
    }

    return { lanes: result, master: this.masterMeter };
  }

  /** Decoded channel data for a lane, for sample-accurate waveform drawing. */
  channelData(key: LaneKey): Float32Array[] | null {
    const lane = this.lanes.get(key);
    if (!lane) return null;
    const channels: Float32Array[] = [];
    for (let index = 0; index < lane.buffer.numberOfChannels; index += 1) {
      channels.push(lane.buffer.getChannelData(index));
    }
    return channels;
  }

  sampleRate(): number {
    return this.context?.sampleRate ?? 44100;
  }

  // -- subscriptions ---------------------------------------------------

  subscribe(listener: PlayerListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): PlayerSnapshot {
    return {
      playing: this.playing,
      position: this.position,
      duration: this.duration,
      loop: this.loopRegion,
      loopEnabled: this.loopEnabled,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  // -- internals -------------------------------------------------------

  private startSources(from: number, when: number): void {
    const context = this.context;
    if (!context) return;
    const loop = this.activeLoop();

    this.startedAtContextTime = when;
    this.startOffset = from;

    for (const lane of this.lanes.values()) {
      this.stopSource(lane);
      const source = context.createBufferSource();
      source.buffer = lane.buffer;
      if (loop) {
        source.loop = true;
        source.loopStart = loop.start;
        source.loopEnd = Math.min(loop.end, lane.buffer.duration);
      }
      source.connect(lane.gain);
      // Every lane gets the same `when` and the same `from`, which is the
      // whole point: they stay locked to one timebase.
      source.start(when, Math.min(from, Math.max(0, lane.buffer.duration - 0.001)));
      source.onended = () => {
        if (source.loop) return;
        // The longest lane finishing means the track finished.
        if (this.playing && this.position >= this.duration - 0.05) {
          this.playing = false;
          this.startOffset = this.duration;
          this.emit();
        }
      };
      lane.source = source;
    }
  }

  private stopSource(lane: Lane): void {
    if (!lane.source) return;
    try {
      lane.source.onended = null;
      lane.source.stop();
    } catch {
      // Already stopped.
    }
    lane.source.disconnect();
    lane.source = null;
  }

  private clampPosition(seconds: number): number {
    if (!Number.isFinite(seconds)) return 0;
    return Math.min(Math.max(0, seconds), Math.max(0, this.duration));
  }

  /** Release every node and close the context. */
  async dispose(): Promise<void> {
    for (const lane of this.lanes.values()) {
      this.stopSource(lane);
      lane.gain.disconnect();
      lane.analyser.disconnect();
    }
    this.lanes.clear();
    this.listeners.clear();
    this.playing = false;
    this.master?.disconnect();
    this.masterAnalyser?.disconnect();
    if (this.context && this.context.state !== 'closed') {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
    this.master = null;
    this.masterAnalyser = null;
  }
}