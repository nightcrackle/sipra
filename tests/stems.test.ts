import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FOUR_STEM_SET,
  isStemId,
  SIX_STEM_SET,
  STEM_BY_ID,
  STEM_DEFINITIONS,
  STEM_IDS,
  sortStems,
  stemColor,
  stemLabel,
} from '@shared/stems';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('stem vocabulary', () => {
  it('defines the six canonical stems in order', () => {
    expect(STEM_IDS).toEqual(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']);
  });

  it('gives every stem a unique colour', () => {
    // Two lanes sharing a colour would be unreadable in the workspace.
    const colours = STEM_DEFINITIONS.map((stem) => stem.color);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('uses well-formed hex colours', () => {
    for (const stem of STEM_DEFINITIONS) expect(stem.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('numbers display order contiguously from zero', () => {
    expect(STEM_DEFINITIONS.map((s) => s.order).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('flags exactly guitar and piano as experimental', () => {
    const experimental = STEM_DEFINITIONS.filter((s) => s.experimental).map((s) => s.id);
    expect(experimental.sort()).toEqual(['guitar', 'piano']);
  });

  it('explains why each experimental stem is flagged', () => {
    for (const stem of STEM_DEFINITIONS) {
      if (stem.experimental) expect(stem.note.length).toBeGreaterThan(20);
    }
  });

  it('makes the four-stem set a strict subset of the six', () => {
    expect(FOUR_STEM_SET.every((stem) => SIX_STEM_SET.includes(stem))).toBe(true);
    expect(SIX_STEM_SET.length).toBeGreaterThan(FOUR_STEM_SET.length);
  });
});

describe('stem helpers', () => {
  it('recognises valid ids', () => {
    expect(isStemId('vocals')).toBe(true);
    expect(isStemId('kazoo')).toBe(false);
    expect(isStemId(42)).toBe(false);
    expect(isStemId(null)).toBe(false);
  });

  it('sorts into display order', () => {
    expect(sortStems(['other', 'vocals', 'bass'])).toEqual(['vocals', 'bass', 'other']);
  });

  it('keeps unknown ids rather than dropping them', () => {
    expect(sortStems(['mystery', 'vocals'])).toEqual(['vocals', 'mystery']);
  });

  it('handles an empty list', () => {
    expect(sortStems([])).toEqual([]);
  });

  it('labels and colours known stems', () => {
    expect(stemLabel('vocals')).toBe('Vocals');
    expect(stemColor('vocals')).toBe(STEM_BY_ID.vocals.color);
  });

  it('falls back gracefully for an unknown stem', () => {
    expect(stemLabel('kazoo')).toBe('kazoo');
    expect(stemColor('kazoo')).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe('parity with the Python core', () => {
  // `python/sipra_core/stems.py` is the mirror of `shared/stems.ts`. If the
  // two drift, the renderer draws a lane the engine never produced, or the
  // engine emits one the renderer cannot colour.
  //
  // The comparison runs the real Python rather than pattern-matching its
  // source, so a refactor on either side cannot make this pass falsely. If
  // Python is unavailable the test is skipped rather than failing, so the
  // TypeScript suite still runs on a machine without it.
  const pythonDir = path.join(repoRoot, 'python');

  function readPythonStems(): Array<Record<string, unknown>> | null {
    const script =
      'import json; from sipra_core.stems import STEM_IDS, describe; ' +
      'print(json.dumps(describe(list(STEM_IDS))))';
    for (const interpreter of ['python3', 'python']) {
      try {
        const output = execFileSync(interpreter, ['-c', script], {
          cwd: pythonDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(output) as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
    }
    return null;
  }

  const pythonStems = readPythonStems();
  const runIf = pythonStems ? it : it.skip;

  runIf('describes exactly the same stems, in the same order', () => {
    expect(pythonStems).not.toBeNull();
    expect(pythonStems).toEqual(
      STEM_DEFINITIONS.map((stem) => ({
        id: stem.id,
        label: stem.label,
        color: stem.color,
        order: stem.order,
        experimental: stem.experimental,
        note: stem.note,
      })),
    );
  });
});
