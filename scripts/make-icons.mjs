/**
 * Regenerate the icon set from `assets/icon.svg`.
 *
 * The SVG is the master: it was vector-traced from the original artwork
 * so it stays crisp at every size, rather than being upscaled from a
 * small bitmap.
 *
 * Requires `rsvg-convert` (librsvg) and ImageMagick (`convert`/`magick`).
 * Only needed when the artwork changes; the generated files are
 * committed.
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const MARK_SIZES = [32, 64, 128, 256, 512];

// Windows needs a 256x256 entry or electron-builder rejects the .ico.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function which(command) {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await which('rsvg-convert'))) {
    throw new Error('rsvg-convert not found. Install librsvg (librsvg2-bin on Debian/Ubuntu).');
  }
  const magick = (await which('magick')) ? 'magick' : 'convert';
  if (!(await which(magick))) {
    throw new Error('ImageMagick not found.');
  }

  const pngDir = path.join(root, 'assets', 'png');
  const buildDir = path.join(root, 'build');
  await mkdir(pngDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  const iconSvg = path.join(root, 'assets', 'icon.svg');
  const markSvg = path.join(root, 'assets', 'icon-mark.svg');

  for (const size of ICON_SIZES) {
    const target = path.join(pngDir, `icon-${size}.png`);
    await run('rsvg-convert', ['-w', String(size), '-h', String(size), iconSvg, '-o', target]);
    console.log(`icon-${size}.png`);
  }

  for (const size of MARK_SIZES) {
    const target = path.join(pngDir, `mark-${size}.png`);
    await run('rsvg-convert', ['-w', String(size), '-h', String(size), markSvg, '-o', target]);
    console.log(`mark-${size}.png`);
  }

  const icoInputs = ICO_SIZES.map((size) => path.join(pngDir, `icon-${size}.png`));
  const icoTarget = path.join(buildDir, 'icon.ico');
  await run(magick, [...icoInputs, icoTarget]);
  console.log('build/icon.ico');

  await run(magick, [path.join(pngDir, 'icon-512.png'), path.join(buildDir, 'icon.png')]);
  console.log('build/icon.png');
}

main().catch((error) => {
  console.error(`make-icons failed: ${error.message}`);
  process.exitCode = 1;
});
