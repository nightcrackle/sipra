import { describe, expect, it } from 'vitest';

import {
  encodeRequest,
  isEvent,
  isFailure,
  isSuccess,
  LineOverflowError,
  LineSplitter,
  parseMessage,
} from '@shared/ndjson';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('LineSplitter', () => {
  it('emits a complete line', () => {
    expect(new LineSplitter().push('hello\n')).toEqual(['hello']);
  });

  it('buffers a partial line until its newline arrives', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('hel')).toEqual([]);
    expect(splitter.push('lo\n')).toEqual(['hello']);
  });

  it('emits several lines from one chunk', () => {
    expect(new LineSplitter().push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF', () => {
    expect(new LineSplitter().push('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('drops blank lines', () => {
    expect(new LineSplitter().push('a\n\n  \nb\n')).toEqual(['a', 'b']);
  });

  it('never splits a multi-byte character across chunks', () => {
    // Decoding each chunk independently corrupts any accented title.
    const splitter = new LineSplitter();
    const bytes = utf8('café ☃\n');
    const first = bytes.slice(0, 4);
    const second = bytes.slice(4);
    expect(splitter.push(first)).toEqual([]);
    expect(splitter.push(second)).toEqual(['café ☃']);
  });

  it('handles a byte-at-a-time stream', () => {
    const splitter = new LineSplitter();
    const bytes = utf8('{"a":"ünïcødé"}\n');
    const lines: string[] = [];
    for (const byte of bytes) lines.push(...splitter.push(Uint8Array.of(byte)));
    expect(lines).toEqual(['{"a":"ünïcødé"}']);
  });

  it('reports what is still buffered', () => {
    const splitter = new LineSplitter();
    splitter.push('partial');
    expect(splitter.pending).toBe(7);
  });

  it('flushes a trailing line with no newline', () => {
    const splitter = new LineSplitter();
    splitter.push('final line');
    expect(splitter.flush()).toEqual(['final line']);
    expect(splitter.flush()).toEqual([]);
  });

  it('resets its buffer', () => {
    const splitter = new LineSplitter();
    splitter.push('partial');
    splitter.reset();
    expect(splitter.pending).toBe(0);
  });

  it('throws rather than growing without bound on a newline-free flood', () => {
    const splitter = new LineSplitter(64);
    expect(() => splitter.push('x'.repeat(200))).toThrow(LineOverflowError);
    // The buffer is dropped so the next real line still parses.
    expect(splitter.push('ok\n')).toEqual(['ok']);
  });

  it('does not throw when a long line does contain a newline', () => {
    const splitter = new LineSplitter(64);
    expect(splitter.push(`${'x'.repeat(200)}\n`)).toHaveLength(1);
  });
});

describe('parseMessage', () => {
  it('parses a success response', () => {
    const message = parseMessage('{"id":"1","ok":true,"result":{"v":2}}');
    expect(message && isSuccess(message)).toBe(true);
    expect(message && isSuccess(message) && message.result).toEqual({ v: 2 });
  });

  it('parses a failure response', () => {
    const message = parseMessage('{"id":"1","ok":false,"error":{"code":"X","message":"bad"}}');
    expect(message && isFailure(message)).toBe(true);
    expect(message && isFailure(message) && message.error.code).toBe('X');
  });

  it('defaults a failure with a missing code', () => {
    const message = parseMessage('{"ok":false,"error":{}}');
    expect(message && isFailure(message) && message.error.code).toBe('INTERNAL');
  });

  it('parses an event', () => {
    const message = parseMessage('{"event":"progress","id":"7","data":{"fraction":0.5}}');
    expect(message && isEvent(message)).toBe(true);
    expect(message && isEvent(message) && message.id).toBe('7');
  });

  it('parses an event with no id', () => {
    const message = parseMessage('{"event":"ready","data":{}}');
    expect(message && isEvent(message) && message.id).toBeUndefined();
  });

  it.each([
    'not json',
    '[1,2,3]',
    '"a string"',
    '42',
    'null',
    '{"ok":true}',
    '{"id":"1"}',
    '{"ok":false}',
    '{"ok":false,"error":"text"}',
  ])('returns null for %s', (line) => {
    expect(parseMessage(line)).toBeNull();
  });

  it('ignores a stray line rather than treating it as a message', () => {
    // A dependency printing to stdout must not kill the session.
    expect(parseMessage('UserWarning: something happened')).toBeNull();
  });
});

describe('encodeRequest', () => {
  it('appends exactly one newline', () => {
    const line = encodeRequest({ id: '1', method: 'ping' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
  });

  it('round-trips through the splitter', () => {
    const splitter = new LineSplitter();
    const lines = splitter.push(encodeRequest({ id: '1', method: 'separate', params: { a: 1 } }));
    expect(JSON.parse(lines[0]!)).toEqual({ id: '1', method: 'separate', params: { a: 1 } });
  });

  it('escapes a newline inside a parameter', () => {
    // A raw newline in a payload would desynchronise the whole stream.
    const line = encodeRequest({ id: '1', method: 'probe', params: { path: 'a\nb' } });
    expect(line.split('\n')).toHaveLength(2);
  });
});
