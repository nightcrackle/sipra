/**
 * Line framing for the Python sidecar's NDJSON stream.
 *
 * A pipe hands you arbitrary chunks: half a message, three messages, a
 * message split across a multi-byte character. This buffers until a
 * newline arrives and never splits a UTF-8 sequence, because decoding
 * each chunk independently corrupts any track title with an accent in it.
 */

export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export class LineOverflowError extends Error {
  constructor(limit: number) {
    super(`Sidecar sent a line longer than ${limit} bytes without a newline`);
    this.name = 'LineOverflowError';
  }
}

export class LineSplitter {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8');
  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  /**
   * Feed a chunk and get back every complete line it finished.
   *
   * Blank lines are dropped: the protocol has no use for them and they
   * are what a flushed-but-empty write produces.
   */
  push(chunk: Uint8Array | string): string[] {
    const text =
      typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;

    if (this.buffer.length > this.maxLineBytes && !this.buffer.includes('\n')) {
      this.buffer = '';
      throw new LineOverflowError(this.maxLineBytes);
    }

    const lines: string[] = [];
    let newlineAt = this.buffer.indexOf('\n');
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.trim()) lines.push(line);
      newlineAt = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /** Anything left in the buffer when the stream ends. */
  flush(): string[] {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder ? [remainder] : [];
  }

  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = '';
  }
}

// ---------------------------------------------------------------------------
// Message shapes — the mirror of python/sipra_core/protocol.py
// ---------------------------------------------------------------------------

export interface SidecarRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface SidecarSuccess {
  id: string;
  ok: true;
  result: unknown;
}

export interface SidecarFailure {
  id?: string;
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface SidecarEvent {
  event: string;
  id?: string;
  data: unknown;
}

export type SidecarMessage = SidecarSuccess | SidecarFailure | SidecarEvent;

export function isEvent(message: SidecarMessage): message is SidecarEvent {
  return 'event' in message;
}

export function isSuccess(message: SidecarMessage): message is SidecarSuccess {
  return 'ok' in message && message.ok === true;
}

export function isFailure(message: SidecarMessage): message is SidecarFailure {
  return 'ok' in message && message.ok === false;
}

/**
 * Parse one line into a message, or `null` if it is not one.
 *
 * The sidecar's stdout is meant to carry protocol lines only, but a
 * dependency that writes to stdout during import would land here. Ignoring
 * unparseable lines keeps one stray `print` from killing the session.
 */
export function parseMessage(line: string): SidecarMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.event === 'string') {
    return {
      event: candidate.event,
      data: candidate.data,
      ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
    };
  }
  if (candidate.ok === true && typeof candidate.id === 'string') {
    return { id: candidate.id, ok: true, result: candidate.result };
  }
  if (candidate.ok === false && candidate.error && typeof candidate.error === 'object') {
    const error = candidate.error as Record<string, unknown>;
    return {
      ok: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'INTERNAL',
        message: typeof error.message === 'string' ? error.message : 'Unknown error',
        ...(error.details && typeof error.details === 'object'
          ? { details: error.details as Record<string, unknown> }
          : {}),
      },
      ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
    };
  }
  return null;
}

export function encodeRequest(request: SidecarRequest): string {
  return `${JSON.stringify(request)}\n`;
}
