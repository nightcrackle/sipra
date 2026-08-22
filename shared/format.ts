/** Display formatting for the workspace and library. */

/**
 * Seconds to `m:ss`, `h:mm:ss`, or with millisecond precision.
 *
 * Negative and non-finite inputs render as a placeholder rather than
 * `NaN:NaN`, which is what a lane shows before its audio has loaded.
 */
export function formatTime(seconds: number, options: { millis?: boolean } = {}): string {
  if (!Number.isFinite(seconds) || seconds < 0) return options.millis ? '0:00.000' : '0:00';

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const base =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;

  if (!options.millis) return base;
  const millis = Math.floor((seconds - whole) * 1000);
  return `${base}.${String(millis).padStart(3, '0')}`;
}

/** A duration for a library row: `3:42`, or `—` when unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  return formatTime(seconds);
}

export function formatDb(
  value: number | null | undefined,
  options: { decimals?: number; sign?: boolean } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === -Infinity) return '-∞ dB';
  const decimals = options.decimals ?? 1;
  const rounded = value.toFixed(decimals);
  const signed = options.sign && value > 0 ? `+${rounded}` : rounded;
  return `${signed} dB`;
}

export function formatLufs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} LUFS`;
}

export function formatLu(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} LU`;
}

export function formatBpm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—';
  // Whole numbers read better on a card; only show a decimal when it matters.
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.05 ? `${rounded}` : value.toFixed(1);
}

export function formatKey(key: string | null | undefined, scale: string | null | undefined): string {
  if (!key) return '—';
  if (!scale) return key;
  return `${key} ${scale === 'minor' ? 'min' : 'maj'}`;
}

/**
 * Confidence as a short word.
 *
 * A number would imply more precision than these estimators have; the
 * point is only to tell the user whether to trust the value.
 */
export function formatConfidence(value: number | null | undefined): 'low' | 'fair' | 'high' | '—' {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'fair';
  return 'low';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatSampleRate(rate: number | null | undefined): string {
  if (!rate || !Number.isFinite(rate)) return '—';
  return `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`;
}

export function formatChannels(channels: number | null | undefined): string {
  if (!channels || !Number.isFinite(channels)) return '—';
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels} ch`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** Relative time for library rows: "just now", "4 hours ago", "12 Mar". */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp)) return '—';
  const delta = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (delta < minute) return 'just now';
  if (delta < hour) {
    const minutes = Math.floor(delta / minute);
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (delta < day) {
    const hours = Math.floor(delta / hour);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (delta < 7 * day) {
    const days = Math.floor(delta / day);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Estimated processing time, phrased loosely because it is a guess. */
export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a moment';
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(seconds / 3600);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Trim a long file name for a fixed-width row, keeping the extension. */
export function truncateMiddle(text: string, max = 40): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
