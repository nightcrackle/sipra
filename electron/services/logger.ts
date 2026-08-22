/**
 * The diagnostic log.
 *
 * A packaged Electron app on Windows has no console attached, so anything
 * written to `process.stderr` — including every trace line the Python
 * sidecar emits — goes nowhere. That left the only evidence about a job
 * that appears frozen being the user's description of the progress bar,
 * which is not enough to tell "still working, badly reported" apart from
 * "actually stopped".
 *
 * So: one plain-text file, written synchronously, always on. Synchronous
 * because the interesting case is a process that stops responding, and a
 * buffered writer loses exactly the tail that matters. The volume is small
 * enough for that to be free — progress is coalesced to one line a second
 * by {@link createJobLogger} before it reaches here.
 *
 * The file stays on the user's machine. Nothing in Sipra uploads it; it
 * exists so a stall can be reported with evidence attached. It does record
 * file paths and any URL that was imported, which is why the header says
 * so and why it is never sent anywhere automatically.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import type { Job } from '../../shared/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Rotate once the current file passes this. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** How many rotated files to keep, not counting the current one. */
export const DEFAULT_MAX_FILES = 3;

/** The most detail one progress line per job per this many ms. */
export const PROGRESS_INTERVAL_MS = 1000;

/**
 * How often a running job restates itself even when nothing changed.
 *
 * This is the line that answers "how long has it been sitting there?" —
 * without it, a stall is a gap in the log, and a gap looks the same as the
 * app having been closed.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface DiagnosticLogOptions {
  /** Directory to write into. Created if missing. */
  dir: string;
  /** File name for the current log. */
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

function two(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function three(value: number): string {
  if (value < 10) return `00${value}`;
  if (value < 100) return `0${value}`;
  return String(value);
}

/** Local time, because the user reads this next to a wall clock. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${three(d.getMilliseconds())}`
  );
}

/**
 * Render a value for the log.
 *
 * Anything that cannot be stringified is described rather than thrown on:
 * a logger that can fail is a logger that takes the process down at the
 * exact moment it was supposed to explain something.
 */
function renderData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    const text = JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    return text ?? String(data);
  } catch {
    return '[unserialisable]';
  }
}

export function formatLine(ms: number, level: LogLevel, scope: string, message: string, data?: unknown): string {
  const rendered = renderData(data);
  const suffix = rendered ? ` ${rendered}` : '';
  // Newlines inside a message would break one line into several and
  // confuse anything that reads this file a line at a time.
  const flat = `${message}${suffix}`.replace(/\r?\n/g, ' ⏎ ');
  return `${formatTimestamp(ms)} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(10)} ${flat}`;
}

export class DiagnosticLog {
  readonly dir: string;
  readonly filePath: string;

  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => number;
  private size = 0;
  private broken = false;

  constructor(options: DiagnosticLogOptions) {
    this.dir = options.dir;
    this.filePath = path.join(options.dir, options.fileName ?? 'sipra.log');
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.now = options.now ?? Date.now;

    try {
      mkdirSync(this.dir, { recursive: true });
      this.size = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    } catch {
      // A log that cannot be opened must not stop the app from starting.
      this.broken = true;
    }
  }

  log(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (this.broken) return;
    const line = `${formatLine(this.now(), level, scope, message, data)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this.size + bytes > this.maxBytes && this.size > 0) this.rotate();
      appendFileSync(this.filePath, line, 'utf8');
      this.size += bytes;
    } catch {
      // Disk full, file locked by another tool, folder removed underneath
      // us. Stop trying rather than throwing on every subsequent line.
      this.broken = true;
    }
  }

  debug(scope: string, message: string, data?: unknown): void {
    this.log('debug', scope, message, data);
  }

  info(scope: string, message: string, data?: unknown): void {
    this.log('info', scope, message, data);
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.log('warn', scope, message, data);
  }

  error(scope: string, message: string, data?: unknown): void {
    this.log('error', scope, message, data);
  }

  /**
   * Write text that arrived as a stream, one log line per source line.
   *
   * The sidecar's stderr arrives in whatever chunks the pipe delivers, so
   * a partial line is held until its newline turns up rather than being
   * logged as a fragment.
   */
  private streamRemainders = new Map<string, string>();

  stream(scope: string, chunk: string, level: LogLevel = 'debug'): void {
    const pending = (this.streamRemainders.get(scope) ?? '') + chunk;
    const parts = pending.split(/\r?\n/);
    // The last element is whatever came after the final newline: either an
    // empty string, or the start of a line still being written.
    const remainder = parts.pop() ?? '';
    // A producer that never emits a newline would otherwise grow this
    // without bound.
    this.streamRemainders.set(scope, remainder.length > 8192 ? '' : remainder);
    if (remainder.length > 8192) parts.push(remainder);
    for (const part of parts) {
      const text = part.trimEnd();
      if (text) this.log(level, scope, text);
    }
  }

  /** The last `bytes` of the current file, for a diagnostics panel. */
  tail(bytes = 64 * 1024): string {
    try {
      const stat = statSync(this.filePath);
      const start = Math.max(0, stat.size - bytes);
      const length = stat.size - start;
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      const fd = openSync(this.filePath, 'r');
      try {
        readSync(fd, buffer, 0, length, start);
      } finally {
        closeSync(fd);
      }
      const text = buffer.toString('utf8');
      // A partial first line, if we cut into the middle of one.
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch {
      return '';
    }
  }

  private rotate(): void {
    const { dir } = this;
    const base = path.basename(this.filePath, path.extname(this.filePath));
    const ext = path.extname(this.filePath);
    const nameFor = (index: number): string => path.join(dir, `${base}.${index}${ext}`);

    const oldest = nameFor(this.maxFiles);
    if (existsSync(oldest)) rmSync(oldest, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = nameFor(index);
      if (existsSync(from)) renameSync(from, nameFor(index + 1));
    }
    if (existsSync(this.filePath)) renameSync(this.filePath, nameFor(1));
    this.size = 0;
  }
}

interface JobLogState {
  status: Job['status'];
  stage: string;
  /** Whole percent, so a bar that visibly moved is what gets logged. */
  percent: number;
  lastLoggedAt: number;
  lastChangeAt: number;
}

export interface JobLoggerOptions {
  now?: () => number;
  progressIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Turn the stream of job updates into a readable log.
 *
 * Every status change and every stage change is logged. Progress within a
 * stage is throttled, because a separation emits hundreds of updates and
 * the useful signal is "it moved" and "it stopped", not each fraction.
 *
 * Returns `{ onJob, heartbeat }`. Call `heartbeat` on a timer: it writes a
 * line for any job that is running but has not changed, which is what
 * turns a stall from a silent gap into a measured one.
 */
export function createJobLogger(log: DiagnosticLog, options: JobLoggerOptions = {}) {
  const now = options.now ?? Date.now;
  const progressInterval = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const heartbeatInterval = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const states = new Map<string, JobLogState>();

  const elapsed = (job: Job): number => now() - (job.startedAt ?? job.createdAt);

  const onJob = (job: Job): void => {
    const percent = Math.round(job.progress.fraction * 100);
    const previous = states.get(job.id);
    const at = now();

    const finished =
      job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';

    if (!previous) {
      log.info('job', `${job.id} ${job.kind} created`, {
        label: job.label,
        status: job.status,
        trackId: job.trackId,
      });
      states.set(job.id, {
        status: job.status,
        stage: job.progress.stage,
        percent,
        lastLoggedAt: at,
        lastChangeAt: at,
      });
      return;
    }

    const statusChanged = previous.status !== job.status;
    const stageChanged = previous.stage !== job.progress.stage;
    const moved = percent !== previous.percent;

    if (moved || stageChanged) previous.lastChangeAt = at;

    const worthLogging =
      statusChanged ||
      stageChanged ||
      finished ||
      (moved && at - previous.lastLoggedAt >= progressInterval);

    if (worthLogging) {
      log.info(
        'job',
        `${job.id} ${job.progress.stage} ${percent}%`,
        {
          status: job.status,
          elapsedMs: elapsed(job),
          ...(stageChanged ? { from: previous.stage } : {}),
          ...(job.error ? { error: job.error.code, message: job.error.message } : {}),
        },
      );
      previous.lastLoggedAt = at;
    }

    previous.status = job.status;
    previous.stage = job.progress.stage;
    previous.percent = percent;

    if (finished) states.delete(job.id);
  };

  const heartbeat = (jobs: Job[]): void => {
    const at = now();
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      const state = states.get(job.id);
      if (!state) continue;
      if (at - state.lastLoggedAt < heartbeatInterval) continue;
      const stalledFor = at - state.lastChangeAt;
      log.warn('job', `${job.id} still ${job.progress.stage} ${state.percent}%`, {
        elapsedMs: elapsed(job),
        unchangedForMs: stalledFor,
      });
      state.lastLoggedAt = at;
    }
  };

  return { onJob, heartbeat };
}
