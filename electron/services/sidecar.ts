/**
 * Client for the Python sidecar.
 *
 * Owns one long-lived child process speaking NDJSON over stdio, matches
 * responses to requests by id, and forwards progress events. If the
 * process dies, every request still in flight is rejected with a clear
 * error instead of hanging forever, and the next request restarts it.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  encodeRequest,
  isEvent,
  isFailure,
  isSuccess,
  LineSplitter,
  parseMessage,
  type SidecarEvent,
} from '../../shared/ndjson';
import type { SipraErrorPayload } from '../../shared/types';

export const SIDECAR_START_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** Long jobs get their own, much longer, ceiling. */
export const LONG_REQUEST_TIMEOUT_MS = 6 * 60 * 60_000;

export class SidecarError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(payload: SipraErrorPayload) {
    super(payload.message);
    this.name = 'SidecarError';
    this.code = payload.code;
    this.details = payload.details ?? {};
  }

  toPayload(): SipraErrorPayload {
    return { code: this.code, message: this.message, details: this.details };
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * One line in the request trace.
 *
 * `sent` when a request goes out, `settled` when its answer comes back —
 * with the elapsed time, which is what tells a slow call apart from a
 * hung one after the fact.
 */
export interface SidecarTrace {
  phase: 'sent' | 'settled';
  id: string;
  method: string;
  durationMs?: number;
  outcome?: 'ok' | 'error' | 'timeout';
  error?: string;
}

export interface SidecarOptions {
  pythonPath: string;
  /** Working directory containing the `sipra_core` package. */
  cwd: string;
  env?: Record<string, string | undefined>;
  onStderr?: (text: string) => void;
  onTrace?: (trace: SidecarTrace) => void;
}

export class Sidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly splitter = new LineSplitter();
  private starting: Promise<void> | null = null;
  private ready = false;
  private stopping = false;
  private stderrTail: string[] = [];

  constructor(private options: SidecarOptions) {
    super();
  }

  get isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  get isReady(): boolean {
    return this.ready && this.isRunning;
  }

  /**
   * Update the spawn options.
   *
   * Merges rather than replaces. `ensureRuntime` calls this once the
   * Python path is known, and an outright replacement quietly dropped the
   * `onStderr` handler wired up at construction — taking the sidecar's
   * diagnostics with it.
   */
  configure(options: Partial<SidecarOptions> & { pythonPath: string }): void {
    this.options = {
      ...this.options,
      ...options,
      env: { ...this.options.env, ...options.env },
    };
  }

  async start(): Promise<void> {
    if (this.isReady) return;
    if (this.starting) return this.starting;

    this.starting = this.spawnAndWait().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.stopping = false;
      this.ready = false;
      this.splitter.reset();
      this.stderrTail = [];

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.pythonPath, ['-u', '-m', 'sipra_core', 'serve'], {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            ...this.options.env,
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8',
            // Keep the sidecar from writing .pyc files into a packaged,
            // possibly read-only, app directory.
            PYTHONDONTWRITEBYTECODE: '1',
          },
          windowsHide: true,
        });
      } catch (error) {
        reject(
          new SidecarError({
            code: 'SIDECAR_SPAWN_FAILED',
            message: `Could not start the audio engine: ${(error as Error).message}`,
          }),
        );
        return;
      }

      this.child = child;

      const timer = setTimeout(() => {
        reject(
          new SidecarError({
            code: 'SIDECAR_TIMEOUT',
            message: 'The audio engine did not start in time.',
            details: { stderr: this.stderrTail.join('\n').slice(-1500) },
          }),
        );
        this.stop();
      }, SIDECAR_START_TIMEOUT_MS);

      const onReady = (): void => {
        clearTimeout(timer);
        this.ready = true;
        resolve();
      };
      this.once('ready', onReady);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consume(chunk));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail.push(chunk);
        // Bounded so a chatty dependency cannot grow this without limit.
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        this.options.onStderr?.(chunk);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.failAll(
          new SidecarError({
            code: 'SIDECAR_SPAWN_FAILED',
            message: `The audio engine could not start: ${error.message}`,
          }),
        );
        reject(error);
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.ready = false;
        this.child = null;
        const wasExpected = this.stopping;
        this.failAll(
          new SidecarError({
            code: 'SIDECAR_EXITED',
            message: wasExpected
              ? 'The audio engine was stopped.'
              : 'The audio engine stopped unexpectedly.',
            details: {
              code,
              signal,
              stderr: this.stderrTail.join('').slice(-1500),
            },
          }),
        );
        this.emit('exit', { code, signal, expected: wasExpected });
        if (!wasExpected) {
          reject(
            new SidecarError({
              code: 'SIDECAR_EXITED',
              message: 'The audio engine stopped unexpectedly.',
              details: { code, signal, stderr: this.stderrTail.join('').slice(-1500) },
            }),
          );
        }
      });
    });
  }

  private consume(chunk: string): void {
    let lines: string[];
    try {
      lines = this.splitter.push(chunk);
    } catch (error) {
      this.emit('warning', (error as Error).message);
      return;
    }

    for (const line of lines) {
      const message = parseMessage(line);
      if (!message) {
        // Not protocol output — a dependency wrote to stdout. Surface it
        // for debugging but do not let it disturb the stream.
        this.emit('stray', line);
        continue;
      }

      if (isEvent(message)) {
        this.handleEvent(message);
        continue;
      }

      const id = message.id;
      if (!id) {
        if (isFailure(message)) this.emit('warning', message.error.message);
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (isSuccess(message)) pending.resolve(message.result);
      else if (isFailure(message)) pending.reject(new SidecarError(message.error));
    }
  }

  private handleEvent(message: SidecarEvent): void {
    if (message.event === 'ready') {
      this.emit('ready', message.data);
      return;
    }
    this.emit('event', message);
    this.emit(message.event, message.data, message.id);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Send a request and wait for its response.
   *
   * Starts the process if it is not running, so callers never have to
   * think about lifecycle.
   */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.isReady) await this.start();
    const child = this.child;
    if (!child) {
      throw new SidecarError({
        code: 'SIDECAR_UNAVAILABLE',
        message: 'The audio engine is not running.',
      });
    }

    const id = randomUUID();
    const startedAt = Date.now();
    const trace = this.options.onTrace;
    trace?.({ phase: 'sent', id, method });

    const settle = (outcome: SidecarTrace['outcome'], error?: string): void => {
      trace?.({ phase: 'settled', id, method, durationMs: Date.now() - startedAt, outcome, error });
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle('timeout');
        reject(
          new SidecarError({
            code: 'SIDECAR_TIMEOUT',
            message: `The audio engine did not answer '${method}' in time.`,
            details: { method, timeoutMs, stderr: this.diagnostics.slice(-1500) },
          }),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value: unknown) => {
          settle('ok');
          resolve(value as T);
        },
        reject: (error: Error) => {
          settle('error', error.message);
          reject(error);
        },
        timer,
        method,
      });

      try {
        child.stdin.write(encodeRequest({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        settle('error', (error as Error).message);
        reject(
          new SidecarError({
            code: 'SIDECAR_WRITE_FAILED',
            message: `Could not talk to the audio engine: ${(error as Error).message}`,
          }),
        );
      }
    });
  }

  /** Fire-and-forget cancel; failures here are not worth surfacing. */
  async cancel(jobId: string): Promise<boolean> {
    if (!this.isReady) return false;
    try {
      const result = await this.request<{ cancelled: boolean }>('cancel', { jobId }, 15_000);
      return Boolean(result?.cancelled);
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;

    try {
      child.stdin.write(encodeRequest({ id: randomUUID(), method: 'shutdown' }));
      child.stdin.end();
    } catch {
      // Already gone.
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child = null;
    this.ready = false;
  }

  /** Recent stderr, for the diagnostics panel. */
  get diagnostics(): string {
    return this.stderrTail.join('').slice(-4000);
  }
}
