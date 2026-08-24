/**
 * Path helpers that need testing without a filesystem.
 *
 * Anything here runs in the main process, where a bad path check is the
 * difference between "streams a stem" and "streams whatever file the
 * renderer asked for".
 */

/**
 * Extensions Sipra will open.
 *
 * The mirror of `SUPPORTED_INPUT_EXTENSIONS` in
 * `python/sipra_core/audio_io.py`; a parity test keeps the two identical.
 * They had drifted: the containers a URL download arrives in were added on
 * the Python side, which meant the engine would happily decode a file that
 * drag-and-drop refused to accept.
 *
 * The last five are containers rather than audio formats. Sipra takes the
 * audio stream out of them, which is what a YouTube download is.
 */
export const AUDIO_EXTENSIONS: readonly string[] = [
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
  '.webm',
  '.mp4',
  '.m4b',
  '.mka',
  '.mkv',
];

/** Characters Windows rejects in a filename, plus control characters. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const ILLEGAL_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export const MAX_FILENAME_LENGTH = 96;

export function hasAudioExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function extensionOf(filePath: string): string {
  const match = /\.[^./\\]+$/.exec(filePath);
  return match ? match[0].toLowerCase() : '';
}

export function baseNameOf(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] ?? filePath;
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

/**
 * Make arbitrary text safe to use as a filename on Windows.
 *
 * Mirrors `sipra_core.ingest.local.safe_filename` — a title sanitised on
 * one side of the bridge and used on the other must come out the same.
 */
export function safeFileName(name: string, fallback = 'track'): string {
  const normalised = (name ?? '').normalize('NFKC').trim();
  let cleaned = normalised
    .replace(ILLEGAL_FILENAME, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');

  if (!cleaned) return fallback;
  // "///" becomes "___" and carries nothing; "!!!" is a real band name.
  if (/^_+$/.test(cleaned)) return fallback;

  const stem = (cleaned.split('.')[0] ?? '').toUpperCase();
  if (RESERVED_NAMES.has(stem)) cleaned = `_${cleaned}`;

  if (cleaned.length > MAX_FILENAME_LENGTH) {
    cleaned = cleaned.slice(0, MAX_FILENAME_LENGTH).replace(/[\s.]+$/, '');
  }
  return cleaned || fallback;
}

/**
 * Normalise a path for comparison: forward slashes, no trailing
 * separator, case-folded on Windows.
 */
export function normaliseForCompare(input: string, platform: string = process.platform): string {
  let text = input.replace(/\\/g, '/');
  // Collapse repeated separators, but keep a UNC prefix intact.
  const uncPrefix = text.startsWith('//') ? '//' : '';
  text = uncPrefix + text.slice(uncPrefix.length).replace(/\/{2,}/g, '/');
  if (text.length > 1) text = text.replace(/\/+$/, '');
  return platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * Whether `child` sits inside `parent`.
 *
 * Both paths must already be absolute and resolved — this function does
 * not resolve `..`, because a symlink-aware caller has to do that with
 * real filesystem calls before asking.
 */
export function isPathInside(
  parent: string,
  child: string,
  platform: string = process.platform,
): boolean {
  const normalisedParent = normaliseForCompare(parent, platform);
  const normalisedChild = normaliseForCompare(child, platform);
  if (!normalisedParent || !normalisedChild) return false;
  if (normalisedChild === normalisedParent) return true;
  // The trailing slash stops "/data/music-backup" matching "/data/music".
  return normalisedChild.startsWith(`${normalisedParent}/`);
}

/** A filename for an exported stem: `Song Title - vocals.wav`. */
export function stemExportName(trackTitle: string, stemId: string, extension = '.wav'): string {
  const base = safeFileName(stripExtension(trackTitle), 'track');
  return `${base} - ${stemId}${extension}`;
}

/** A filename for an exported mix, naming the stems it contains. */
export function mixExportName(
  trackTitle: string,
  stemIds: readonly string[],
  extension = '.wav',
): string {
  const base = safeFileName(stripExtension(trackTitle), 'track');
  if (stemIds.length === 0) return `${base} - mix${extension}`;
  // Naming six stems produces an unusable filename; past three, count them.
  const suffix =
    stemIds.length <= 3 ? stemIds.join('+') : `${stemIds.length} stems`;
  return `${base} - ${suffix}${extension}`;
}

/** A directory-safe id for a track's workspace folder. */
export function trackDirName(title: string, id: string): string {
  const base = safeFileName(stripExtension(title), 'track');
  const shortId = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'track';
  return `${base}-${shortId}`;
}
