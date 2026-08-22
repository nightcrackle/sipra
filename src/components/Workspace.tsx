import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { mediaUrl } from '@shared/ipc';
import { resolveMix } from '@shared/mix';
import { decodePeaks, type PeakData } from '@shared/peaks';
import { type StemId, stemLabel } from '@shared/stems';

import { createMeterState, type MeterState } from '../audio/meters';
import { normaliseLoop, wrapToLoop } from '../audio/loop';
import { ORIGINAL_LANE, StemPlayer } from '../audio/StemPlayer';
import {
  scrollToReveal,
  viewportEnd,
  zoomAt,
  zoomToFit,
  zoomToRange,
} from '../audio/viewport';
import { useStore } from '../state/store';
import { BackIcon, DownloadIcon, WarningIcon } from './Icons';
import { InfoStrip } from './InfoStrip';
import { StemLane } from './StemLane';
import { TimeRuler } from './TimeRuler';
import { TransportBar } from './TransportBar';

/** How much one wheel notch zooms. */
const WHEEL_ZOOM_FACTOR = 1.22;

export function Workspace(): JSX.Element | null {
  const track = useStore((state) => state.activeTrack);
  const lanes = useStore((state) => state.lanes);
  const viewport = useStore((state) => state.viewport);
  const loop = useStore((state) => state.loop);
  const loopEnabled = useStore((state) => state.loopEnabled);
  const playing = useStore((state) => state.playing);
  const position = useStore((state) => state.position);
  const followPlayhead = useStore((state) => state.followPlayhead);
  const referenceOriginal = useStore((state) => state.referenceOriginal);
  const backingBusDb = useStore((state) => state.backingBusDb);
  const masterGainDb = useStore((state) => state.masterGainDb);
  const settings = useStore((state) => state.settings);
  const loading = useStore((state) => state.loadingWorkspace);
  const workspaceError = useStore((state) => state.workspaceError);
  const jobs = useStore((state) => state.jobs);

  const closeTrack = useStore((state) => state.closeTrack);
  const setViewport = useStore((state) => state.setViewport);
  const setLoop = useStore((state) => state.setLoop);
  const setLoopEnabled = useStore((state) => state.setLoopEnabled);
  const setPlaying = useStore((state) => state.setPlaying);
  const setPosition = useStore((state) => state.setPosition);
  const setFollowPlayhead = useStore((state) => state.setFollowPlayhead);
  const setReferenceOriginal = useStore((state) => state.setReferenceOriginal);
  const setBackingBusDb = useStore((state) => state.setBackingBusDb);
  const setMasterGainDb = useStore((state) => state.setMasterGainDb);
  const toggleLaneMute = useStore((state) => state.toggleLaneMute);
  const toggleLaneSolo = useStore((state) => state.toggleLaneSolo);
  const toggleLaneSelection = useStore((state) => state.toggleLaneSelection);
  const setLaneGain = useStore((state) => state.setLaneGain);
  const setWorkspaceLoading = useStore((state) => state.setWorkspaceLoading);
  const setWorkspaceError = useStore((state) => state.setWorkspaceError);
  const setExportOpen = useStore((state) => state.setExportOpen);
  const pushNotice = useStore((state) => state.pushNotice);

  const playerRef = useRef<StemPlayer | null>(null);
  const [peaks, setPeaks] = useState<Map<string, PeakData>>(new Map());
  const [meters, setMeters] = useState<Map<string, MeterState>>(new Map());
  const [masterMeter, setMasterMeter] = useState<MeterState>(() => createMeterState());
  const [now, setNow] = useState(0);
  const [hasOriginal, setHasOriginal] = useState(false);

  const analysing = jobs.some(
    (job) => job.kind === 'analyze' && job.trackId === track?.id && job.status === 'running',
  );

  const mix = useMemo(
    () =>
      resolveMix(lanes, {
        masterGainDb,
        referenceOriginal,
        backingBusDb,
      }),
    [lanes, masterGainDb, referenceOriginal, backingBusDb],
  );

  // -- load ------------------------------------------------------------

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    const player = new StemPlayer();
    playerRef.current = player;
    setPeaks(new Map());
    setMeters(new Map());
    setHasOriginal(false);
    setWorkspaceLoading(true);

    const load = async (): Promise<void> => {
      try {
        // Peaks first: the waveform can be on screen long before several
        // hundred megabytes of audio have finished decoding.
        const peakEntries = await Promise.all(
          [null, ...track.stems.map((stem) => stem.id)].map(async (stemId) => {
            const buffer = await window.sipra.files.readPeaks(track.id, stemId);
            if (!buffer) return null;
            return [stemId ?? ORIGINAL_LANE, decodePeaks(buffer)] as const;
          }),
        );
        if (cancelled) return;
        setPeaks(new Map(peakEntries.filter(Boolean) as Array<[string, PeakData]>));

        for (const stem of track.stems) {
          if (cancelled) return;
          const response = await fetch(mediaUrl(track.id, 'stem', stem.id));
          if (!response.ok) throw new Error(`Could not read the ${stemLabel(stem.id)} stem.`);
          const buffer = await player.decode(await response.arrayBuffer());
          if (cancelled) return;
          player.setLane(stem.id, buffer);
        }

        // The original is loaded last: it is only needed for A/B, and the
        // stems are what the user is waiting to see.
        try {
          const response = await fetch(mediaUrl(track.id, 'source'));
          if (response.ok) {
            const buffer = await player.decode(await response.arrayBuffer());
            if (!cancelled) {
              player.setLane(ORIGINAL_LANE, buffer);
              player.setLaneGain(ORIGINAL_LANE, 0);
              setHasOriginal(true);
            }
          }
        } catch {
          // A/B is a convenience; losing it must not block the workspace.
        }

        if (!cancelled) setWorkspaceLoading(false);
      } catch (error) {
        if (!cancelled) setWorkspaceError((error as Error).message);
      }
    };

    void load();

    return () => {
      cancelled = true;
      void player.dispose();
      playerRef.current = null;
    };
  }, [track, setWorkspaceLoading, setWorkspaceError]);

  // -- mix -------------------------------------------------------------

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.applyGains(mix.gains, mix.originalGain);
    player.setMasterGain(1);
  }, [mix]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setLoop(loop, loopEnabled);
  }, [loop, loopEnabled]);

  // -- animation loop --------------------------------------------------

  useEffect(() => {
    let frame = 0;
    const tick = (timestamp: number): void => {
      const player = playerRef.current;
      if (player) {
        const snapshot = player.snapshot();
        setPosition(snapshot.position);
        if (snapshot.playing !== useStore.getState().playing) setPlaying(snapshot.playing);

        const sampled = player.sampleMeters(timestamp, settings.meterBallistics);
        setMeters(new Map(sampled.lanes));
        setMasterMeter(sampled.master);
        setNow(timestamp);

        if (snapshot.playing && useStore.getState().followPlayhead) {
          const current = useStore.getState().viewport;
          const next = scrollToReveal(current, snapshot.position);
          if (next.start !== current.start) setViewport(next);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [setPosition, setPlaying, setViewport, settings.meterBallistics]);

  // -- transport -------------------------------------------------------

  const togglePlay = useCallback(() => {
    void playerRef.current?.toggle();
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const player = playerRef.current;
      if (!player) return;
      const target = loopEnabled && loop ? wrapToLoop(loop, seconds) : seconds;
      player.seek(target);
      setPosition(player.position);
    },
    [loop, loopEnabled, setPosition],
  );

  const handleLoopDrag = useCallback(
    (anchor: number, cursor: number, committed: boolean) => {
      if (!track) return;
      const region = normaliseLoop(anchor, cursor, track.durationSeconds);
      if (!region) {
        if (committed) setLoop(null, false);
        return;
      }
      setLoop(region, true);
    },
    [track, setLoop],
  );

  // -- keyboard --------------------------------------------------------

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from a field the user is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'Home':
          event.preventDefault();
          seek(0);
          break;
        case 'l':
        case 'L':
          if (loop) setLoopEnabled(!loopEnabled);
          break;
        case 'o':
        case 'O':
          if (!event.repeat) setReferenceOriginal(true);
          break;
        case '0':
          setViewport(zoomToFit(useStore.getState().viewport));
          break;
        case '+':
        case '=':
          setViewport(zoomAt(useStore.getState().viewport, 1.5, useStore.getState().position));
          break;
        case '-':
        case '_':
          setViewport(zoomAt(useStore.getState().viewport, 1 / 1.5, useStore.getState().position));
          break;
        case 'Escape':
          closeTrack();
          break;
        default:
          break;
      }
    };

    const release = (event: KeyboardEvent): void => {
      if (event.key === 'o' || event.key === 'O') setReferenceOriginal(false);
    };

    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', release);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keyup', release);
    };
  }, [togglePlay, seek, loop, loopEnabled, setLoopEnabled, setReferenceOriginal, setViewport, closeTrack]);

  // -- wheel zoom ------------------------------------------------------

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.shiftKey) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      // The lane controls column is not part of the timeline.
      const timelineLeft = rect.left + 188;
      const width = rect.width - 188;
      if (width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - timelineLeft) / width));
      const anchor = viewport.start + ratio * viewport.duration;
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setViewport(zoomAt(viewport, factor, anchor));
    },
    [viewport, setViewport],
  );

  if (!track) return null;

  const reanalyse = async (): Promise<void> => {
    try {
      await window.sipra.tracks.reanalyse(track.id);
    } catch (error) {
      pushNotice({
        level: 'error',
        title: 'Could not re-analyse',
        message: (error as Error).message,
      });
    }
  };

  const downloadStem = async (stemId: StemId): Promise<void> => {
    const target = await window.sipra.files.pickSaveTarget(`${track.title} - ${stemId}.wav`, ['wav']);
    if (!target) return;
    try {
      await window.sipra.tracks.exportStem(track.id, stemId, target);
      pushNotice({ level: 'info', title: 'Stem saved', message: target });
    } catch (error) {
      pushNotice({ level: 'error', title: 'Export failed', message: (error as Error).message });
    }
  };

  const experimental = lanes.filter(
    (lane) => lane.stemId === 'piano' || lane.stemId === 'guitar',
  );

  return (
    <section className="workspace" onWheel={handleWheel}>
      <header className="workspace__header">
        <button type="button" className="btn btn--ghost btn--icon" onClick={closeTrack} aria-label="Back to library">
          <BackIcon size={17} />
        </button>
        <h2 className="workspace__title" title={track.title}>
          {track.title}
        </h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {track.modelId} · {track.device}
        </span>
        <div className="grow" />
        {loading ? <span className="muted">Loading audio…</span> : null}
        <button type="button" className="btn" onClick={() => setExportOpen(true)} disabled={loading}>
          <DownloadIcon size={15} />
          Export
        </button>
      </header>

      <InfoStrip track={track} onReanalyse={() => void reanalyse()} analysing={analysing} />

      {workspaceError ? (
        <div className="workspace__warning">
          <WarningIcon size={16} />
          <span>{workspaceError}</span>
        </div>
      ) : null}

      {experimental.length > 0 ? (
        <div className="workspace__warning">
          <WarningIcon size={16} />
          <span>
            {experimental.map((lane) => stemLabel(lane.stemId)).join(' and ')}{' '}
            {experimental.length > 1 ? 'come' : 'comes'} from the 6-stem model, which is the
            weakest part of Demucs. Expect bleed — piano in particular is best treated as a
            rough guide rather than a finished stem.
          </span>
        </div>
      ) : null}

      <div className="workspace__scroller">
        <TimeRuler viewport={viewport} loop={loop} onSeek={seek} />
        <div className="workspace__lanes">
          {lanes.map((lane) => (
            <StemLane
              key={lane.stemId}
              lane={lane}
              peaks={peaks.get(lane.stemId) ?? null}
              channels={playerRef.current?.channelData(lane.stemId) ?? null}
              sampleRate={playerRef.current?.sampleRate() ?? track.sampleRate}
              viewport={viewport}
              loop={loop}
              position={position}
              meter={meters.get(lane.stemId) ?? createMeterState()}
              now={now}
              anySolo={mix.anySolo}
              onToggleMute={toggleLaneMute}
              onToggleSolo={toggleLaneSolo}
              onToggleSelect={toggleLaneSelection}
              onGainChange={setLaneGain}
              onSeek={seek}
              onLoopDrag={handleLoopDrag}
            />
          ))}
        </div>

        <div className="row" style={{ padding: '12px 18px', flexWrap: 'wrap', gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Download a single stem:
          </span>
          {lanes.map((lane) => (
            <button
              key={lane.stemId}
              type="button"
              className="btn btn--sm"
              onClick={() => void downloadStem(lane.stemId)}
            >
              <DownloadIcon size={13} />
              {stemLabel(lane.stemId)}
            </button>
          ))}
        </div>
      </div>

      <TransportBar
        playing={playing}
        position={position}
        duration={track.durationSeconds}
        loopEnabled={loopEnabled}
        hasLoop={loop !== null}
        followPlayhead={followPlayhead}
        referenceOriginal={referenceOriginal}
        hasOriginal={hasOriginal}
        backingBusDb={backingBusDb}
        masterGainDb={masterGainDb}
        masterMeter={masterMeter}
        now={now}
        onTogglePlay={togglePlay}
        onStop={() => {
          playerRef.current?.stop();
          setPosition(0);
        }}
        onSkipStart={() => seek(0)}
        onToggleLoop={() => setLoopEnabled(!loopEnabled)}
        onClearLoop={() => setLoop(null, false)}
        onToggleFollow={() => setFollowPlayhead(!followPlayhead)}
        onToggleReference={setReferenceOriginal}
        onBackingChange={setBackingBusDb}
        onMasterChange={setMasterGainDb}
        onZoomIn={() => setViewport(zoomAt(viewport, 1.5, position))}
        onZoomOut={() => setViewport(zoomAt(viewport, 1 / 1.5, position))}
        onZoomFit={() => setViewport(zoomToFit(viewport))}
        onZoomLoop={() => loop && setViewport(zoomToRange(viewport, loop.start, loop.end))}
      />
      <span className="sr-only">
        Showing {viewport.start.toFixed(1)} to {viewportEnd(viewport).toFixed(1)} seconds.
      </span>
    </section>
  );
}

export default Workspace;
