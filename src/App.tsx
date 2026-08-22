import { useCallback, useEffect, useState } from 'react';

import type { Notice } from '@shared/ipc';

import { ExportDialog } from './components/ExportDialog';
import { ImportDialog } from './components/ImportDialog';
import { JobsPanel } from './components/JobsPanel';
import { LibraryView } from './components/LibraryView';
import { Notices } from './components/Notices';
import { RuntimeSetup } from './components/RuntimeSetup';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { Workspace } from './components/Workspace';
import { useStore } from './state/store';

export function App(): JSX.Element {
  const view = useStore((state) => state.view);
  const runtime = useStore((state) => state.runtime);
  const setRuntime = useStore((state) => state.setRuntime);
  const setCapabilities = useStore((state) => state.setCapabilities);
  const setLibrary = useStore((state) => state.setLibrary);
  const setSettings = useStore((state) => state.setSettings);
  const setJobs = useStore((state) => state.setJobs);
  const upsertJob = useStore((state) => state.upsertJob);
  const pushNotice = useStore((state) => state.pushNotice);
  const setImportOpen = useStore((state) => state.setImportOpen);
  const folderId = useStore((state) => state.folderId);

  const [dragging, setDragging] = useState(false);
  const [booted, setBooted] = useState(false);

  // -- bootstrap -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      try {
        const [library, settings, status, jobs] = await Promise.all([
          window.sipra.library.get(),
          window.sipra.settings.get(),
          window.sipra.runtime.status(),
          window.sipra.jobs.list(),
        ]);
        if (cancelled) return;
        setLibrary(library);
        setSettings(settings);
        setRuntime(status);
        setJobs(jobs);

        if (status.stage === 'ready') {
          // Capabilities need the sidecar running, so this is deliberately
          // not part of the first paint.
          const capabilities = await window.sipra.runtime.capabilities();
          if (!cancelled) setCapabilities(capabilities);
        }
      } catch (error) {
        if (!cancelled) {
          pushNotice({
            level: 'error',
            title: 'Could not start',
            message: (error as Error).message,
          });
        }
      } finally {
        if (!cancelled) setBooted(true);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [setLibrary, setSettings, setRuntime, setJobs, setCapabilities, pushNotice]);

  // -- live updates ----------------------------------------------------

  useEffect(() => {
    const offRuntime = window.sipra.runtime.onChanged((status) => {
      setRuntime(status);
      if (status.capabilities) setCapabilities(status.capabilities);
    });
    const offLibrary = window.sipra.library.onChanged((state) => setLibrary(state));
    const offJob = window.sipra.jobs.onUpdated((job) => {
      upsertJob(job);
      if (job.status === 'failed' && job.error) {
        pushNotice({ level: 'error', title: job.label, message: job.error.message });
      }
    });
    const offNotice = window.sipra.notices.on((notice: Notice) => pushNotice(notice));

    return () => {
      offRuntime();
      offLibrary();
      offJob();
      offNotice();
    };
  }, [setRuntime, setCapabilities, setLibrary, upsertJob, pushNotice]);

  // -- drag and drop ---------------------------------------------------

  const importPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      const { accepted, rejected } = await window.sipra.files.resolveDropped(paths);
      if (rejected.length > 0) {
        pushNotice({
          level: 'warning',
          title: rejected.length === 1 ? 'One file was skipped' : `${rejected.length} files were skipped`,
          message: 'Sipra opens audio files: WAV, MP3, FLAC, OGG, M4A, AAC and AIFF.',
        });
      }
      const target = typeof folderId === 'string' ? folderId : null;
      for (const path of accepted) {
        try {
          await window.sipra.tracks.separate({ path, folderId: target });
        } catch (error) {
          pushNotice({
            level: 'error',
            title: 'Could not start',
            message: (error as Error).message,
          });
        }
      }
    },
    [folderId, pushNotice],
  );

  useEffect(() => {
    let depth = 0;

    const onDragEnter = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      // Electron exposes the real path on dropped files; the browser File
      // object alone would give us no way to read it in the main process.
      const paths = files
        .map((file) => (file as File & { path?: string }).path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0);
      if (paths.length > 0) void importPaths(paths);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importPaths]);

  const install = useCallback(async (): Promise<void> => {
    const status = await window.sipra.runtime.install();
    setRuntime(status);
    if (status.stage === 'ready') {
      setCapabilities(await window.sipra.runtime.capabilities());
    }
  }, [setRuntime, setCapabilities]);

  if (!booted) {
    return <div className="setup" />;
  }

  if (runtime && runtime.stage !== 'ready') {
    return (
      <>
        <RuntimeSetup status={runtime} onInstall={install} />
        <Notices />
      </>
    );
  }

  return (
    <div className="app">
      <TitleBar onImport={() => setImportOpen(true)} />

      <div className="app__body">
        <Sidebar />
        <main className="app__main">
          {view === 'workspace' ? (
            <Workspace />
          ) : (
            <LibraryView onImport={() => setImportOpen(true)} />
          )}
        </main>
      </div>

      <JobsPanel />

      {dragging ? (
        <div className="dropzone">
          <div className="dropzone__panel">
            <p className="dropzone__title">Drop to separate</p>
            <p className="dropzone__hint">
              WAV, MP3, FLAC, OGG, M4A, AAC or AIFF — processed on this computer.
            </p>
          </div>
        </div>
      ) : null}

      <ImportDialog />
      <ExportDialog />
      <SettingsDialog />
      <Notices />
    </div>
  );
}

export default App;
