/**
 * The diagnostic log.
 *
 * This file exists because a stalled job in a packaged build left no
 * evidence at all: the sidecar's trace lines went to the main process's
 * stderr, and a packaged Windows app has no console attached. So the
 * properties under test are the ones a bug report depends on — that lines
 * get written, that they survive a long-running job without filling the
 * disk, that a stall is visible as a measured gap rather than as silence,
 * and that nothing the logger is handed can take the app down with it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createJobLogger,
  DiagnosticLog,
  formatLine,
  formatTimestamp,
  HEARTBEAT_INTERVAL_MS,
  PROGRESS_INTERVAL_MS,
} from '../electron/services/logger';
import type { Job } from '../shared/types';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sipra-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function lines(file: string): string[] {
  return read(file).trimEnd().split('\n');
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'separate',
    label: 'Song.mp3',
    status: 'running',
    progress: { stage: 'separate', fraction: 0.5 },
    createdAt: 1_000,
    startedAt: 1_000,
    finishedAt: null,
    error: null,
    trackId: null,
    ...overrides,
  } as Job;
}

describe('formatTimestamp', () => {
  it('renders local time to the millisecond', () => {
    const text = formatTimestamp(new Date(2026, 7, 22, 9, 5, 3, 42).getTime());
    expect(text).toBe('2026-08-22 09:05:03.042');
  });

  it('pads every field so lines stay aligned', () => {
    const text = formatTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6).getTime());
    expect(text).toBe('2026-01-02 03:04:05.006');
  });
});

describe('formatLine', () => {
  const at = new Date(2026, 7, 22, 9, 0, 0, 0).getTime();

  it('carries the level, the scope and the message', () => {
    const line = formatLine(at, 'info', 'job', 'started');
    expect(line).toContain('INFO');
    expect(line).toContain('job');
    expect(line).toContain('started');
  });

  it('appends structured data as JSON', () => {
    expect(formatLine(at, 'info', 'job', 'progress', { percent: 80 })).toContain('{"percent":80}');
  });

  it('omits the data section when there is none', () => {
    expect(formatLine(at, 'info', 'job', 'bare').trimEnd()).toMatch(/bare$/);
  });

  it('flattens newlines so one entry stays one line', () => {
    const line = formatLine(at, 'error', 'sidecar', 'Traceback:\nline one\r\nline two');
    expect(line).not.toContain('\n');
    expect(line).toContain('line two');
  });

  it('describes data it cannot serialise rather than throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLine(at, 'warn', 'job', 'circular', circular)).not.toThrow();
    expect(formatLine(at, 'warn', 'job', 'circular', circular)).toContain('[unserialisable]');
  });

  it('renders a bigint rather than throwing on it', () => {
    expect(formatLine(at, 'info', 'job', 'big', { n: 10n })).toContain('"10"');
  });
});

describe('DiagnosticLog', () => {
  it('creates the directory and writes a line', () => {
    const log = new DiagnosticLog({ dir: path.join(dir, 'nested', 'logs') });
    log.info('app', 'hello');
    expect(existsSync(log.filePath)).toBe(true);
    expect(read(log.filePath)).toContain('hello');
  });

  it('appends rather than truncating on a second run', () => {
    const first = new DiagnosticLog({ dir });
    first.info('app', 'run one');
    const second = new DiagnosticLog({ dir });
    second.info('app', 'run two');
    expect(read(second.filePath)).toContain('run one');
    expect(read(second.filePath)).toContain('run two');
  });

  it('writes each level', () => {
    const log = new DiagnosticLog({ dir });
    log.debug('a', 'd');
    log.info('a', 'i');
    log.warn('a', 'w');
    log.error('a', 'e');
    expect(lines(log.filePath)).toHaveLength(4);
  });

  describe('rotation', () => {
    it('rotates once the file passes its ceiling', () => {
      const log = new DiagnosticLog({ dir, maxBytes: 400 });
      for (let i = 0; i < 20; i += 1) log.info('app', `line ${i} ${'x'.repeat(40)}`);
      expect(existsSync(path.join(dir, 'sipra.1.log'))).toBe(true);
      expect(statSync(log.filePath).size).toBeLessThanOrEqual(400);
    });

    it('keeps the newest content in the current file', () => {
      const log = new DiagnosticLog({ dir, maxBytes: 300 });
      for (let i = 0; i < 30; i += 1) log.info('app', `entry-${i} ${'y'.repeat(30)}`);
      expect(read(log.filePath)).toContain('entry-29');
    });

    it('never keeps more than maxFiles rotated copies', () => {
      const log = new DiagnosticLog({ dir, maxBytes: 200, maxFiles: 2 });
      for (let i = 0; i < 60; i += 1) log.info('app', `entry-${i} ${'z'.repeat(30)}`);
      expect(existsSync(path.join(dir, 'sipra.1.log'))).toBe(true);
      expect(existsSync(path.join(dir, 'sipra.2.log'))).toBe(true);
      expect(existsSync(path.join(dir, 'sipra.3.log'))).toBe(false);
    });

    it('does not rotate an empty file, however long the first line is', () => {
      const log = new DiagnosticLog({ dir, maxBytes: 10 });
      log.info('app', 'a line far longer than the ceiling');
      expect(existsSync(path.join(dir, 'sipra.1.log'))).toBe(false);
      expect(read(log.filePath)).toContain('far longer');
    });
  });

  describe('stream', () => {
    it('splits a chunk into one entry per line', () => {
      const log = new DiagnosticLog({ dir });
      log.stream('sidecar', 'first\nsecond\n');
      expect(lines(log.filePath)).toHaveLength(2);
    });

    it('holds a partial line until its newline arrives', () => {
      const log = new DiagnosticLog({ dir });
      log.stream('sidecar', 'half of a ');
      expect(existsSync(log.filePath)).toBe(false);
      log.stream('sidecar', 'line\n');
      expect(read(log.filePath)).toContain('half of a line');
    });

    it('keeps two producers from interleaving mid-line', () => {
      const log = new DiagnosticLog({ dir });
      log.stream('a', 'alpha ');
      log.stream('b', 'beta\n');
      log.stream('a', 'rest\n');
      const text = read(log.filePath);
      expect(text).toContain('beta');
      expect(text).toContain('alpha rest');
    });

    it('flushes a producer that never emits a newline rather than growing forever', () => {
      const log = new DiagnosticLog({ dir });
      log.stream('sidecar', 'x'.repeat(9000));
      expect(read(log.filePath)).toContain('xxxx');
    });

    it('drops blank lines', () => {
      const log = new DiagnosticLog({ dir });
      log.stream('sidecar', '\n\n  \n');
      expect(existsSync(log.filePath)).toBe(false);
    });
  });

  describe('tail', () => {
    it('returns the whole file when it is small', () => {
      const log = new DiagnosticLog({ dir });
      log.info('app', 'only line');
      expect(log.tail()).toContain('only line');
    });

    it('returns the end of a large file, starting on a line boundary', () => {
      const log = new DiagnosticLog({ dir, maxBytes: 10 * 1024 * 1024 });
      for (let i = 0; i < 500; i += 1) log.info('app', `entry-${i}`);
      const tail = log.tail(400);
      expect(tail).toContain('entry-499');
      expect(tail).not.toContain('entry-0 ');
      // No half-line at the front.
      expect(tail.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2} /);
    });

    it('returns empty rather than throwing when there is no file', () => {
      expect(new DiagnosticLog({ dir }).tail()).toBe('');
    });
  });

  describe('failure handling', () => {
    it('does not throw when a directory sits where the log file should be', () => {
      // Not hypothetical: a user who once unzipped something into the logs
      // folder can leave this behind, and it must not stop the app.
      mkdirSync(path.join(dir, 'sipra.log'), { recursive: true });
      const log = new DiagnosticLog({ dir });
      expect(() => log.info('app', 'still fine')).not.toThrow();
      expect(log.tail()).toBe('');
    });

    it('stops writing after a failure instead of throwing on every line', () => {
      const log = new DiagnosticLog({ dir });
      log.info('app', 'before');
      rmSync(dir, { recursive: true, force: true });
      for (let i = 0; i < 5; i += 1) {
        expect(() => log.info('app', 'after')).not.toThrow();
      }
    });
  });
});

describe('createJobLogger', () => {
  function harness(startAt = 0) {
    let clock = startAt;
    const log = new DiagnosticLog({ dir, now: () => clock });
    const logger = createJobLogger(log, { now: () => clock });
    return {
      log,
      logger,
      advance: (ms: number) => {
        clock += ms;
      },
      text: () => (existsSync(log.filePath) ? read(log.filePath) : ''),
      count: () => (existsSync(log.filePath) ? lines(log.filePath).length : 0),
    };
  }

  it('logs a job the first time it is seen', () => {
    const h = harness();
    h.logger.onJob(makeJob({ status: 'queued' }));
    expect(h.text()).toContain('created');
    expect(h.text()).toContain('Song.mp3');
  });

  it('logs every stage change', () => {
    const h = harness();
    h.logger.onJob(makeJob());
    h.logger.onJob(makeJob({ progress: { stage: 'collect', fraction: 0.78 } }));
    h.logger.onJob(makeJob({ progress: { stage: 'write', fraction: 0.8 } }));
    expect(h.text()).toContain('collect');
    expect(h.text()).toContain('write');
  });

  it('records where a stage changed from', () => {
    const h = harness();
    h.logger.onJob(makeJob());
    h.logger.onJob(makeJob({ progress: { stage: 'write', fraction: 0.8 } }));
    expect(h.text()).toContain('"from":"separate"');
  });

  it('throttles progress inside one stage', () => {
    const h = harness();
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0 } }));
    const before = h.count();
    // Twenty visible steps, all inside one throttle window.
    for (let i = 1; i <= 20; i += 1) {
      h.advance(10);
      h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: i / 100 } }));
    }
    expect(h.count() - before).toBeLessThanOrEqual(1);
  });

  it('lets progress through again once the window has passed', () => {
    const h = harness();
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0 } }));
    h.advance(PROGRESS_INTERVAL_MS + 1);
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0.2 } }));
    h.advance(PROGRESS_INTERVAL_MS + 1);
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0.4 } }));
    expect(h.text()).toContain('20%');
    expect(h.text()).toContain('40%');
  });

  it('ignores updates that do not change the whole percent', () => {
    const h = harness();
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0.5 } }));
    const before = h.count();
    h.advance(PROGRESS_INTERVAL_MS + 1);
    h.logger.onJob(makeJob({ progress: { stage: 'separate', fraction: 0.5004 } }));
    expect(h.count()).toBe(before);
  });

  it('always logs the outcome, throttle or not', () => {
    const h = harness();
    h.logger.onJob(makeJob());
    h.advance(5);
    h.logger.onJob(
      makeJob({ status: 'succeeded', progress: { stage: 'succeeded', fraction: 1 } }),
    );
    expect(h.text()).toContain('succeeded');
  });

  it('records the error on a failure', () => {
    const h = harness();
    h.logger.onJob(makeJob());
    h.logger.onJob(
      makeJob({
        status: 'failed',
        error: { code: 'DOWNLOAD_FAILED', message: 'yt-dlp did not respond' },
      }),
    );
    expect(h.text()).toContain('DOWNLOAD_FAILED');
    expect(h.text()).toContain('yt-dlp did not respond');
  });

  it('forgets a job once it finishes', () => {
    const h = harness();
    h.logger.onJob(makeJob());
    h.logger.onJob(makeJob({ status: 'succeeded' }));
    h.logger.onJob(makeJob({ status: 'running' }));
    // Seen as new again, which is the observable side of having been dropped.
    expect(h.text().match(/created/g)).toHaveLength(2);
  });

  describe('heartbeat', () => {
    it('says nothing while a job is still moving', () => {
      const h = harness();
      const job = makeJob();
      h.logger.onJob(job);
      h.advance(HEARTBEAT_INTERVAL_MS - 1);
      const before = h.count();
      h.logger.heartbeat([job]);
      expect(h.count()).toBe(before);
    });

    it('restates a job that has not changed, with how long it has been', () => {
      const h = harness();
      const job = makeJob({ progress: { stage: 'write', fraction: 0.8 } });
      h.logger.onJob(job);
      h.advance(HEARTBEAT_INTERVAL_MS + 1);
      h.logger.heartbeat([job]);
      const text = h.text();
      expect(text).toContain('still write 80%');
      expect(text).toContain('unchangedForMs');
    });

    it('measures the stall from the last change, not the last log line', () => {
      const h = harness();
      const stalled = makeJob({ progress: { stage: 'write', fraction: 0.8 } });
      h.logger.onJob(stalled);
      h.advance(HEARTBEAT_INTERVAL_MS + 1);
      h.logger.heartbeat([stalled]);
      h.advance(HEARTBEAT_INTERVAL_MS + 1);
      h.logger.heartbeat([stalled]);
      const last = lines(h.log.filePath).at(-1) ?? '';
      const unchanged = Number(/"unchangedForMs":(\d+)/.exec(last)?.[1] ?? 0);
      expect(unchanged).toBeGreaterThan(HEARTBEAT_INTERVAL_MS * 2);
    });

    it('ignores jobs that are not running', () => {
      const h = harness();
      const job = makeJob({ status: 'queued' });
      h.logger.onJob(job);
      h.advance(HEARTBEAT_INTERVAL_MS * 4);
      const before = h.count();
      h.logger.heartbeat([job]);
      expect(h.count()).toBe(before);
    });

    it('ignores a job it has never seen', () => {
      const h = harness();
      h.advance(HEARTBEAT_INTERVAL_MS * 4);
      expect(() => h.logger.heartbeat([makeJob()])).not.toThrow();
      expect(h.count()).toBe(0);
    });
  });
});
