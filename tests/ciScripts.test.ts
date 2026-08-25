/**
 * The two scripts that stand between the test suite and GitHub.
 *
 * Neither is exciting, and both fail in ways that are invisible when they
 * go wrong: a badge whose URL still says OWNER/REPO renders as a blank
 * image forever, and a summary parser that misreads a report quietly
 * claims a run passed. They are covered for the same reason the rest of
 * this suite exists — a silent wrong answer is worse than a loud one.
 */

import { describe, expect, it } from 'vitest';

import { formatSummary, parseJUnit, parseVitest } from '../scripts/test-summary.mjs';
import { isRepoSlug, parseRemote, rewrite } from '../scripts/set-repo.mjs';

describe('parseVitest', () => {
  const report = {
    numPassedTests: 608,
    numFailedTests: 0,
    numPendingTests: 3,
    numTotalTests: 611,
    // Describe blocks, not files — five times the file count. Reporting
    // this as "files" is how a summary starts lying about its own suite.
    numTotalTestSuites: 120,
    testResults: Array.from({ length: 21 }, () => ({ name: 'x' })),
  };

  it('reads the counts', () => {
    expect(parseVitest(report)).toEqual({
      passed: 608,
      failed: 0,
      skipped: 3,
      total: 611,
      files: 21,
    });
  });

  it('counts files, not describe blocks', () => {
    expect(parseVitest(report).files).toBe(21);
  });

  it('accepts the report as text', () => {
    expect(parseVitest(JSON.stringify(report)).passed).toBe(608);
  });

  it('treats missing fields as zero rather than NaN', () => {
    expect(parseVitest({})).toEqual({ passed: 0, failed: 0, skipped: 0, total: 0, files: 0 });
  });
});

describe('parseJUnit', () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="2" tests="474" time="15.2">' +
    '</testsuite></testsuites>';

  it('derives passed from the totals pytest reports', () => {
    // JUnit states totals and failures, never passes.
    expect(parseJUnit(xml)).toMatchObject({ passed: 472, failed: 0, skipped: 2, total: 474 });
  });

  it('counts errors as failures', () => {
    const withErrors = xml.replace('errors="0"', 'errors="3"');
    expect(parseJUnit(withErrors).failed).toBe(3);
  });

  it('counts failures and errors together', () => {
    const both = xml.replace('errors="0"', 'errors="1"').replace('failures="0"', 'failures="2"');
    expect(both).toContain('errors="1"');
    expect(parseJUnit(both).failed).toBe(3);
    expect(parseJUnit(both).passed).toBe(469);
  });

  it('returns zeros for a report with no testsuite element', () => {
    expect(parseJUnit('<testsuites/>').total).toBe(0);
  });

  it('is not confused by attributes on the outer element', () => {
    const nested =
      '<testsuites tests="999"><testsuite tests="10" failures="1" errors="0" skipped="0">' +
      '</testsuite></testsuites>';
    expect(parseJUnit(nested).total).toBe(10);
  });
});

describe('formatSummary', () => {
  it('marks a clean run as passed', () => {
    const line = formatSummary('Python', { passed: 474, failed: 0, skipped: 0, total: 474, files: 0 });
    expect(line).toContain('✅');
    expect(line).toContain('474 passed');
    expect(line).not.toContain('failed');
  });

  it('marks any failure as failed', () => {
    const line = formatSummary('Python', { passed: 470, failed: 4, skipped: 0, total: 474, files: 0 });
    expect(line).toContain('❌');
    expect(line).toContain('4 failed');
  });

  it('mentions files only when it knows how many', () => {
    expect(
      formatSummary('TS', { passed: 1, failed: 0, skipped: 0, total: 1, files: 21 }),
    ).toContain('21 files');
    expect(
      formatSummary('Py', { passed: 1, failed: 0, skipped: 0, total: 1, files: 0 }),
    ).not.toContain('files');
  });
});

describe('parseRemote', () => {
  it.each([
    ['git@github.com:alice/sipra.git', 'alice/sipra'],
    ['git@github.com:alice/sipra', 'alice/sipra'],
    ['https://github.com/alice/sipra.git', 'alice/sipra'],
    ['https://github.com/alice/sipra', 'alice/sipra'],
    ['ssh://git@github.com/alice/sipra.git', 'alice/sipra'],
    ['  https://github.com/alice/sipra\n', 'alice/sipra'],
  ])('reads %s', (url, expected) => {
    expect(parseRemote(url)).toBe(expected);
  });

  it('returns null for anything else', () => {
    expect(parseRemote('')).toBeNull();
    expect(parseRemote(undefined)).toBeNull();
    expect(parseRemote('not a url')).toBeNull();
  });
});

describe('isRepoSlug', () => {
  it('accepts a normal owner and repository', () => {
    expect(isRepoSlug('alice/sipra')).toBe(true);
    expect(isRepoSlug('alice-b/si.pra_2')).toBe(true);
  });

  it('rejects anything that would produce a broken badge', () => {
    expect(isRepoSlug('')).toBe(false);
    expect(isRepoSlug(undefined)).toBe(false);
    expect(isRepoSlug('alice')).toBe(false);
    expect(isRepoSlug('alice/sipra/extra')).toBe(false);
    expect(isRepoSlug('/sipra')).toBe(false);
    expect(isRepoSlug('-alice/sipra')).toBe(false);
  });
});

describe('rewrite', () => {
  const readme = [
    '[![TypeScript](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)]' +
      '(https://github.com/OWNER/REPO/actions/workflows/ci.yml)',
    '[![Python](https://github.com/OWNER/REPO/actions/workflows/python.yml/badge.svg)]' +
      '(https://github.com/OWNER/REPO/actions/workflows/python.yml)',
  ].join('\n');

  it('replaces every occurrence, image and link alike', () => {
    const out = rewrite(readme, 'alice/sipra');
    expect(out).not.toContain('OWNER/REPO');
    expect(out.match(/alice\/sipra/g)).toHaveLength(4);
  });

  it('keeps the workflow file names', () => {
    const out = rewrite(readme, 'alice/sipra');
    expect(out).toContain('workflows/ci.yml/badge.svg');
    expect(out).toContain('workflows/python.yml/badge.svg');
  });

  it('is repeatable, so a rename is one command not a hand edit', () => {
    const once = rewrite(readme, 'alice/sipra');
    const twice = rewrite(once, 'bob/sipra');
    expect(twice).not.toContain('alice');
    expect(twice.match(/bob\/sipra/g)).toHaveLength(4);
  });

  it('leaves non-Actions GitHub links alone', () => {
    const text = 'See https://github.com/facebookresearch/demucs for the model.';
    expect(rewrite(text, 'alice/sipra')).toBe(text);
  });
});
