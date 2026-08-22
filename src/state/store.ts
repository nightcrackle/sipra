/**
 * Application state.
 *
 * Zustand rather than Redux: the store is mostly a cache of what the main
 * process owns (library, jobs, settings) plus the workspace's own view
 * state. Mutations that touch disk go through IPC and come back as events,
 * so the store is never the source of truth for anything persistent.
 */

import { create } from 'zustand';

import type { Notice } from '@shared/ipc';
import {
  createLanes,
  type LaneState,
  resetLanes,
  resolveMix,
  setGain,
  setSelection,
  toggleMute,
  toggleSelection,
  toggleSolo,
} from '@shared/mix';
import { sortStems, type StemId } from '@shared/stems';
import type {
  Capabilities,
  Job,
  LibraryState,
  RuntimeStatus,
  Settings,
  Track,
  TrackSortKey,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { emptyLibrary } from '@shared/library';

import { clampViewport, createViewport, type Viewport } from '../audio/viewport';
import type { LoopRegion } from '../audio/loop';

export type ViewMode = 'library' | 'workspace';

/** Level the backing bus sits at when the user selects a subset of stems. */
export const DEFAULT_BACKING_DB = -9;

export interface UiState {
  view: ViewMode;
  appReady: boolean;
  runtime: RuntimeStatus | null;
  capabilities: Capabilities | null;
  settings: Settings;

  library: LibraryState;
  jobs: Job[];
  notices: Array<Notice & { id: string }>;

  // Library browsing
  searchText: string;
  folderId: string | null | undefined;
  scope: 'live' | 'trash';
  sortKey: TrackSortKey;
  sortDescending: boolean;
  selectedTrackIds: string[];

  // Workspace
  activeTrack: Track | null;
  lanes: LaneState[];
  viewport: Viewport;
  loop: LoopRegion | null;
  loopEnabled: boolean;
  playing: boolean;
  position: number;
  followPlayhead: boolean;
  referenceOriginal: boolean;
  backingBusDb: number | null;
  masterGainDb: number;
  loadingWorkspace: boolean;
  workspaceError: string | null;

  // Dialogs
  exportOpen: boolean;
  settingsOpen: boolean;
  importOpen: boolean;
}

export interface UiActions {
  setView(view: ViewMode): void;
  setRuntime(status: RuntimeStatus): void;
  setCapabilities(capabilities: Capabilities | null): void;
  setSettings(settings: Settings): void;
  setLibrary(library: LibraryState): void;
  setJobs(jobs: Job[]): void;
  upsertJob(job: Job): void;
  pushNotice(notice: Notice): void;
  dismissNotice(id: string): void;

  setSearchText(text: string): void;
  setFolder(folderId: string | null | undefined): void;
  setScope(scope: 'live' | 'trash'): void;
  setSort(key: TrackSortKey, descending?: boolean): void;
  selectTracks(ids: string[]): void;
  toggleTrackSelection(id: string, additive: boolean): void;

  openTrack(track: Track): void;
  closeTrack(): void;
  setWorkspaceLoading(loading: boolean): void;
  setWorkspaceError(message: string | null): void;

  setLanes(lanes: LaneState[]): void;
  toggleLaneMute(stemId: StemId): void;
  toggleLaneSolo(stemId: StemId): void;
  toggleLaneSelection(stemId: StemId): void;
  setLaneGain(stemId: StemId, gainDb: number): void;
  selectOnly(stemIds: StemId[]): void;
  resetMix(): void;

  setViewport(viewport: Viewport): void;
  setLoop(loop: LoopRegion | null, enabled?: boolean): void;
  setLoopEnabled(enabled: boolean): void;
  setPlaying(playing: boolean): void;
  setPosition(position: number): void;
  setFollowPlayhead(follow: boolean): void;
  setReferenceOriginal(active: boolean): void;
  setBackingBusDb(db: number | null): void;
  setMasterGainDb(db: number): void;

  setExportOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setImportOpen(open: boolean): void;
}

export type Store = UiState & UiActions;

let noticeCounter = 0;

const initialState: UiState = {
  view: 'library',
  appReady: false,
  runtime: null,
  capabilities: null,
  settings: { ...DEFAULT_SETTINGS },

  library: emptyLibrary(),
  jobs: [],
  notices: [],

  searchText: '',
  folderId: undefined,
  scope: 'live',
  sortKey: 'recent',
  sortDescending: true,
  selectedTrackIds: [],

  activeTrack: null,
  lanes: [],
  viewport: createViewport(0),
  loop: null,
  loopEnabled: false,
  playing: false,
  position: 0,
  followPlayhead: true,
  referenceOriginal: false,
  backingBusDb: DEFAULT_BACKING_DB,
  masterGainDb: 0,
  loadingWorkspace: false,
  workspaceError: null,

  exportOpen: false,
  settingsOpen: false,
  importOpen: false,
};

export const useStore = create<Store>((set, get) => ({
  ...initialState,

  setView: (view) => set({ view }),
  setRuntime: (runtime) => set({ runtime, appReady: runtime.stage === 'ready' }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setSettings: (settings) => set({ settings }),
  setLibrary: (library) => {
    // Keep the open track in step with the library so a rename or a move
    // is reflected in the workspace header immediately.
    const active = get().activeTrack;
    const refreshed = active ? library.tracks.find((t) => t.id === active.id) ?? null : null;
    set({ library, ...(active ? { activeTrack: refreshed ?? active } : {}) });
  },
  setJobs: (jobs) => set({ jobs }),
  upsertJob: (job) =>
    set((state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index === -1) return { jobs: [job, ...state.jobs] };
      const jobs = [...state.jobs];
      jobs[index] = job;
      return { jobs };
    }),

  pushNotice: (notice) =>
    set((state) => {
      noticeCounter += 1;
      const entry = { ...notice, id: `notice-${noticeCounter}` };
      // Cap the stack; a burst of failures should not bury the UI.
      return { notices: [entry, ...state.notices].slice(0, 4) };
    }),
  dismissNotice: (id) =>
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),

  setSearchText: (searchText) => set({ searchText }),
  setFolder: (folderId) => set({ folderId, selectedTrackIds: [] }),
  setScope: (scope) => set({ scope, selectedTrackIds: [] }),
  setSort: (sortKey, descending) =>
    set((state) => ({
      sortKey,
      sortDescending: descending ?? (state.sortKey === sortKey ? !state.sortDescending : true),
    })),
  selectTracks: (selectedTrackIds) => set({ selectedTrackIds }),
  toggleTrackSelection: (id, additive) =>
    set((state) => {
      if (!additive) return { selectedTrackIds: [id] };
      return state.selectedTrackIds.includes(id)
        ? { selectedTrackIds: state.selectedTrackIds.filter((candidate) => candidate !== id) }
        : { selectedTrackIds: [...state.selectedTrackIds, id] };
    }),

  openTrack: (track) => {
    const stemIds = sortStems(track.stems.map((stem) => stem.id)) as StemId[];
    set({
      view: 'workspace',
      activeTrack: track,
      lanes: createLanes(stemIds),
      viewport: createViewport(track.durationSeconds),
      loop: null,
      loopEnabled: false,
      playing: false,
      position: 0,
      referenceOriginal: false,
      masterGainDb: 0,
      loadingWorkspace: true,
      workspaceError: null,
    });
  },
  closeTrack: () =>
    set({
      view: 'library',
      activeTrack: null,
      lanes: [],
      playing: false,
      position: 0,
      loop: null,
      loopEnabled: false,
      loadingWorkspace: false,
      workspaceError: null,
    }),
  setWorkspaceLoading: (loadingWorkspace) => set({ loadingWorkspace }),
  setWorkspaceError: (workspaceError) => set({ workspaceError, loadingWorkspace: false }),

  setLanes: (lanes) => set({ lanes }),
  toggleLaneMute: (stemId) => set((state) => ({ lanes: toggleMute(state.lanes, stemId) })),
  toggleLaneSolo: (stemId) => set((state) => ({ lanes: toggleSolo(state.lanes, stemId) })),
  toggleLaneSelection: (stemId) =>
    set((state) => ({ lanes: toggleSelection(state.lanes, stemId) })),
  setLaneGain: (stemId, gainDb) =>
    set((state) => ({ lanes: setGain(state.lanes, stemId, gainDb) })),
  selectOnly: (stemIds) => set((state) => ({ lanes: setSelection(state.lanes, stemIds) })),
  resetMix: () =>
    set((state) => ({
      lanes: resetLanes(state.lanes),
      masterGainDb: 0,
      referenceOriginal: false,
    })),

  setViewport: (viewport) => set({ viewport: clampViewport(viewport) }),
  setLoop: (loop, enabled) => set({ loop, loopEnabled: enabled ?? loop !== null }),
  setLoopEnabled: (loopEnabled) => set((state) => ({ loopEnabled: loopEnabled && !!state.loop })),
  setPlaying: (playing) => set({ playing }),
  setPosition: (position) => set({ position }),
  setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),
  setReferenceOriginal: (referenceOriginal) => set({ referenceOriginal }),
  setBackingBusDb: (backingBusDb) => set({ backingBusDb }),
  setMasterGainDb: (masterGainDb) => set({ masterGainDb }),

  setExportOpen: (exportOpen) => set({ exportOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setImportOpen: (importOpen) => set({ importOpen }),
}));

/** The mix implied by the current lane and reference state. */
export function selectResolvedMix(state: Store): ReturnType<typeof resolveMix> {
  return resolveMix(state.lanes, {
    masterGainDb: state.masterGainDb,
    referenceOriginal: state.referenceOriginal,
    backingBusDb: state.backingBusDb,
  });
}

export function selectActiveJobs(state: Store): Job[] {
  return state.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
}
