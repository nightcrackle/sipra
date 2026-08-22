/**
 * Bundle the Electron main process and preload script with esbuild.
 *
 * Two different output formats, deliberately:
 *   - main is ESM, because it uses `import.meta.url` to locate resources
 *     (Electron has supported an ESM main since v28)
 *   - preload is CommonJS, because a sandboxed preload script cannot be
 *     an ES module
 */

import { build, context } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-electron');
const watch = process.argv.includes('--watch');

/** Electron and Node built-ins are provided at runtime, never bundled. */
const external = ['electron', 'node:*'];

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
  external,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
};

const targets = [
  {
    ...shared,
    entryPoints: [path.join(root, 'electron', 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    format: 'esm',
    // Electron's ESM loader needs a real extension on relative imports;
    // bundling to a single file sidesteps the question entirely.
    banner: {
      js: "import { createRequire as __sipraCreateRequire } from 'node:module';\nconst require = __sipraCreateRequire(import.meta.url);",
    },
  },
  {
    ...shared,
    entryPoints: [path.join(root, 'electron', 'preload.ts')],
    outfile: path.join(outDir, 'preload.cjs'),
    format: 'cjs',
  },
];

async function run() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  if (watch) {
    const contexts = await Promise.all(targets.map((target) => context(target)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('[build-main] watching for changes');
    return;
  }

  await Promise.all(targets.map((target) => build(target)));
  console.log('[build-main] built main.js and preload.cjs');
}

run().catch((error) => {
  console.error('[build-main] failed:', error);
  process.exitCode = 1;
});
