/**
 * Electron main process.
 *
 * Sets up the window, the private `sipra://` media scheme, and the
 * services the renderer talks to through IPC. The renderer runs with no
 * Node integration, context isolation on and the sandbox enabled — it can
 * only do what `electron/ipc/register.ts` explicitly allows.
 */

import { app, BrowserWindow, Menu, nativeImage, net, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MEDIA_SCHEME } from '../shared/ipc';
import { registerIpc } from './ipc/register';
import { JobRegistry } from './services/jobs';
import { LibraryService } from './services/library';
import { MediaRequestError, parseMediaUrl, resolveMediaPath } from './services/media';
import { RuntimeManager } from './services/runtime';
import { SettingsService } from './services/settings';
import { Sidecar } from './services/sidecar';
import { ensureWorkspace, workspaceLayout } from './services/workspace';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const DEV_SERVER_URL = process.env.SIPRA_DEV_SERVER_URL ?? 'http://localhost:5273';
const isDev = !app.isPackaged;

/**
 * The scheme must be registered as privileged before `app.ready`, or
 * `fetch()` from the renderer is blocked and `decodeAudioData` never sees
 * the bytes.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

interface Services {
  settings: SettingsService;
  library: LibraryService;
  jobs: JobRegistry;
  sidecar: Sidecar;
  runtime: RuntimeManager;
}

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;

function resourcePath(...segments: string[]): string {
  // Packaged: resources sit next to the asar. Development: repo root.
  const base = app.isPackaged ? process.resourcesPath : path.join(moduleDir, '..');
  return path.join(base, ...segments);
}

function buildServices(): Services {
  const workspaceRoot = path.join(app.getPath('userData'), 'workspace');
  const layout = workspaceLayout(workspaceRoot);

  const settings = new SettingsService(layout.settingsFile);
  const library = new LibraryService(layout.libraryFile, workspaceRoot);
  const jobs = new JobRegistry();

  const binDir = resourcePath('bin');
  const corePath = resourcePath('python');

  const runtime = new RuntimeManager({
    runtimeDir: path.join(app.getPath('userData'), 'runtime'),
    corePath,
    binDir,
    requirementsDir: path.join(corePath, 'requirements'),
  });

  const sidecar = new Sidecar({
    pythonPath: '',
    cwd: corePath,
    env: {
      SIPRA_BIN_DIR: binDir,
      SIPRA_FFMPEG: path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
      // Stage tracing is cheap and makes a stalled job locatable. On in
      // development always; in a packaged build only if asked for.
      SIPRA_TRACE_STAGES: process.env.SIPRA_TRACE_STAGES ?? (isDev ? '1' : '0'),
    },
    onStderr: (chunk) => {
      // Always surfaced, not just in development: when a user reports a
      // job that appears frozen, this is the record of where it stopped.
      process.stderr.write(`[sidecar] ${chunk}`);
    },
  });

  return { settings, library, jobs, sidecar, runtime };
}

function registerMediaProtocol(library: LibraryService, workspaceRoot: string): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const parsed = parseMediaUrl(request.url);
      const state = await library.getState();
      const { filePath, contentType } = resolveMediaPath(parsed, state, workspaceRoot);
      const response = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
      const headers = new Headers(response.headers);
      headers.set('Content-Type', contentType);
      // These files are immutable once written, so let the renderer cache
      // them rather than re-reading a stem on every zoom.
      headers.set('Cache-Control', 'private, max-age=3600');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const status = error instanceof MediaRequestError ? error.status : 500;
      return new Response((error as Error).message, {
        status,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#0B0C0E',
    show: false,
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(resourcePath('build', 'icon.png')),
    title: 'Sipra',
    webPreferences: {
      preload: path.join(moduleDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Nothing in this app should open a new window or navigate away. Any
  // attempt is treated as an external link and handed to the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && url.startsWith(DEV_SERVER_URL);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url);
    }
  });

  if (isDev) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(moduleDir, '..', 'dist', 'index.html'));
  }

  return window;
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}

function buildMenu(): void {
  // A minimal menu: the app is driven from its own UI, but Windows users
  // still expect the standard editing and zoom accelerators to work.
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    services = buildServices();
    const workspaceRoot = path.join(app.getPath('userData'), 'workspace');
    await ensureWorkspace(workspaceLayout(workspaceRoot));

    registerMediaProtocol(services.library, workspaceRoot);
    buildMenu();

    mainWindow = createWindow();

    registerIpc({
      ...services,
      getWindow: () => mainWindow,
      resourcePath,
      workspaceRoot,
      isDev,
    });

    // Housekeeping that must not delay the first paint.
    void services.library.pruneExpiredTrash().catch(() => undefined);
    void services.runtime.detect().catch(() => undefined);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void services?.sidecar.stop();
  });
}
