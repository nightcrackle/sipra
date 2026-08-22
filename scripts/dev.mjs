/**
 * Development launcher: Vite dev server, esbuild in watch mode, Electron.
 *
 * Electron is started only once Vite is actually listening — launching it
 * first gives you a blank window and a confusing console error instead of
 * a page that loads a second later.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = process.env.SIPRA_DEV_SERVER_URL ?? 'http://localhost:5273';

const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  run('node', ['scripts/build-main.mjs', '--watch']);
  run('npx', ['vite', '--host', 'localhost']);

  const ready = await waitForServer(DEV_URL);
  if (!ready) {
    console.error(`[dev] Vite did not start at ${DEV_URL}`);
    shutdown(1);
    return;
  }

  // Give esbuild a moment to finish its first pass before Electron reads
  // dist-electron/main.js.
  await new Promise((resolve) => setTimeout(resolve, 600));

  const electron = run('npx', ['electron', '.'], {
    env: { ...process.env, SIPRA_DEV_SERVER_URL: DEV_URL, NODE_ENV: 'development' },
  });
  electron.on('close', (code) => shutdown(code ?? 0));
}

main().catch((error) => {
  console.error('[dev] failed:', error);
  shutdown(1);
});
