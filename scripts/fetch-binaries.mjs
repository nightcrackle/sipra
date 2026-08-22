/**
 * Fetch the helper binaries that ship inside the installer.
 *
 * These are not committed to the repository: they are large, they are
 * platform-specific, and they carry their own licences. This script pulls
 * them into `bin/` before packaging.
 *
 * **yt-dlp is behind a build flag.** Set `SIPRA_BUNDLE_YTDLP=0` to build an
 * installer with no downloader in it. The URL-import feature then reports
 * itself unavailable and everything else works unchanged. Read `NOTICE.md`
 * before deciding — downloading from YouTube is contrary to YouTube's Terms
 * of Service, and shipping a downloader is a choice with consequences for
 * whoever publishes the build.
 *
 *     node scripts/fetch-binaries.mjs
 *     SIPRA_BUNDLE_YTDLP=0 node scripts/fetch-binaries.mjs
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binDir = path.join(root, 'bin');

const platform = process.platform;
const bundleYtdlp = process.env.SIPRA_BUNDLE_YTDLP !== '0';

const SOURCES = {
  win32: {
    ffmpeg: {
      // A build with the codecs Sipra needs and nothing else exotic.
      url: 'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
      archive: 'zip',
      extract: ['ffmpeg.exe', 'ffprobe.exe'],
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
      archive: null,
      target: 'yt-dlp.exe',
    },
  },
  linux: {
    ffmpeg: {
      url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
      archive: 'tar',
      extract: ['ffmpeg', 'ffprobe'],
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
      archive: null,
      target: 'yt-dlp',
    },
  },
};

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function download(url, target) {
  console.log(`  fetching ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  await pipeline(response.body, createWriteStream(target));
}

/**
 * Extract named files from an archive using whatever the host provides.
 *
 * Deliberately shells out rather than adding an unzip dependency: this
 * runs on a build machine, not on a user's computer.
 */
async function extract(archivePath, names, kind) {
  const staging = path.join(binDir, '.extract');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  if (kind === 'zip') {
    if (platform === 'win32') {
      await run('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${staging}" -Force`,
      ]);
    } else {
      await run('unzip', ['-q', '-o', archivePath, '-d', staging]);
    }
  } else {
    await run('tar', ['-xf', archivePath, '-C', staging]);
  }

  // Archives nest their contents in a versioned directory, so find each
  // file by name rather than assuming a layout.
  for (const name of names) {
    const found = await locate(staging, name);
    if (!found) throw new Error(`${name} was not found inside ${path.basename(archivePath)}`);
    await run(platform === 'win32' ? 'cmd' : 'cp',
      platform === 'win32' ? ['/c', 'move', '/Y', found, path.join(binDir, name)] : [found, path.join(binDir, name)]);
    console.log(`  extracted ${name}`);
  }

  await rm(staging, { recursive: true, force: true });
  await rm(archivePath, { force: true });
}

async function locate(directory, name) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await locate(full, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function main() {
  const sources = SOURCES[platform];
  if (!sources) {
    console.error(`No helper binaries are defined for ${platform}.`);
    process.exitCode = 1;
    return;
  }

  await mkdir(binDir, { recursive: true });

  const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (await exists(path.join(binDir, ffmpegName))) {
    console.log('ffmpeg: already present');
  } else {
    console.log('ffmpeg:');
    const archivePath = path.join(binDir, `ffmpeg-download.${sources.ffmpeg.archive}`);
    await download(sources.ffmpeg.url, archivePath);
    await extract(archivePath, sources.ffmpeg.extract, sources.ffmpeg.archive);
  }

  if (!bundleYtdlp) {
    console.log('yt-dlp: skipped (SIPRA_BUNDLE_YTDLP=0)');
    console.log('        URL import will report itself unavailable in this build.');
    return;
  }

  const ytdlpTarget = path.join(binDir, sources.ytdlp.target);
  if (await exists(ytdlpTarget)) {
    console.log('yt-dlp: already present');
    return;
  }

  console.log('yt-dlp:');
  await download(sources.ytdlp.url, ytdlpTarget);
  if (platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await chmod(ytdlpTarget, 0o755);
  }
  console.log('  done');
  console.log('');
  console.log('  Reminder: read NOTICE.md. Downloading from YouTube is contrary to');
  console.log('  YouTube\'s Terms of Service. Build with SIPRA_BUNDLE_YTDLP=0 to omit it.');
}

main().catch((error) => {
  console.error(`fetch-binaries failed: ${error.message}`);
  process.exitCode = 1;
});
