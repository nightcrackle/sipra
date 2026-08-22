import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonStore } from '../electron/services/jsonStore';

interface Shape {
  value: number;
  name: string;
}

const defaults = (): Shape => ({ value: 0, name: 'default' });

function normalise(raw: unknown): Shape {
  if (!raw || typeof raw !== 'object') return defaults();
  const candidate = raw as Partial<Shape>;
  return {
    value: typeof candidate.value === 'number' ? candidate.value : 0,
    name: typeof candidate.name === 'string' ? candidate.name : 'default',
  };
}

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sipra-store-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function makeStore(fileName = 'state.json'): JsonStore<Shape> {
  return new JsonStore<Shape>({
    filePath: path.join(directory, fileName),
    defaults,
    normalise,
  });
}

describe('JsonStore', () => {
  it('returns defaults when the file does not exist', async () => {
    expect(await makeStore().read()).toEqual(defaults());
  });

  it('persists and reads back', async () => {
    const store = makeStore();
    await store.write({ value: 42, name: 'answer' });
    expect(await makeStore().read()).toEqual({ value: 42, name: 'answer' });
  });

  it('creates missing parent directories', async () => {
    const store = new JsonStore<Shape>({
      filePath: path.join(directory, 'a', 'b', 'state.json'),
      defaults,
      normalise,
    });
    await store.write({ value: 1, name: 'x' });
    expect(await store.read()).toEqual({ value: 1, name: 'x' });
  });

  it('writes formatted JSON a human can read', async () => {
    const store = makeStore();
    await store.write({ value: 1, name: 'x' });
    expect(await fs.readFile(store.path, 'utf8')).toContain('\n  "value": 1');
  });

  it('applies an update function', async () => {
    const store = makeStore();
    await store.write({ value: 1, name: 'x' });
    await store.update((current) => ({ ...current, value: current.value + 1 }));
    expect((await store.read()).value).toBe(2);
  });

  it('leaves no temporary files behind', async () => {
    const store = makeStore();
    await store.write({ value: 1, name: 'x' });
    const entries = await fs.readdir(directory);
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
  });

  it('serialises concurrent writes so the last one wins', async () => {
    // Two rapid updates must not interleave their temp files.
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        store.write({ value: index, name: `n${index}` }),
      ),
    );
    const written = normalise(JSON.parse(await fs.readFile(store.path, 'utf8')));
    expect(written).toEqual({ value: 19, name: 'n19' });
  });

  it('recovers from a corrupt file instead of refusing to start', async () => {
    const store = makeStore();
    await fs.writeFile(store.path, '{ this is not json', 'utf8');
    expect(await store.read()).toEqual(defaults());
  });

  it('keeps a copy of a corrupt file so it can be recovered by hand', async () => {
    const store = makeStore();
    await fs.writeFile(store.path, '{ broken', 'utf8');
    await store.read();
    const entries = await fs.readdir(directory);
    expect(entries.some((entry) => entry.includes('.corrupt-'))).toBe(true);
  });

  it('normalises what it reads', async () => {
    const store = makeStore();
    await fs.writeFile(store.path, JSON.stringify({ value: 'not a number' }), 'utf8');
    expect(await store.read()).toEqual({ value: 0, name: 'default' });
  });

  it('caches after the first read', async () => {
    const store = makeStore();
    await store.write({ value: 5, name: 'cached' });
    await fs.writeFile(store.path, JSON.stringify({ value: 99, name: 'changed' }), 'utf8');
    expect((await store.read()).value).toBe(5);
  });

  it('re-reads from disk after invalidation', async () => {
    const store = makeStore();
    await store.write({ value: 5, name: 'cached' });
    await fs.writeFile(store.path, JSON.stringify({ value: 99, name: 'changed' }), 'utf8');
    store.invalidate();
    expect((await store.read()).value).toBe(99);
  });

  it('fingerprints a value deterministically', () => {
    expect(JsonStore.fingerprint({ a: 1 })).toBe(JsonStore.fingerprint({ a: 1 }));
    expect(JsonStore.fingerprint({ a: 1 })).not.toBe(JsonStore.fingerprint({ a: 2 }));
  });
});
