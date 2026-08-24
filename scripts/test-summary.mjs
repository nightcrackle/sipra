#!/usr/bin/env node
/**
 * Write a one-line test result into GitHub's job summary.
 *
 * Reads either Vitest's JSON report or pytest's JUnit XML, so both halves
 * of the suite report the same way. Outside CI it prints to the console
 * instead, which is what makes it runnable — and therefore testable —
 * without a GitHub Actions runner.
 *
 * A failure to summarise must never fail a build. The tests have already
 * passed or failed by the time this runs, and their exit code is the real
 * verdict; this only decides how the run reads afterwards.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Counts as reported by a test runner. */
export function parseVitest(json) {
  const report = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    total: report.numTotalTests ?? 0,
    // `testResults` is one entry per file. `numTotalTestSuites` counts
    // describe blocks, which is five times larger and reads as nonsense
    // next to a file count.
    files: report.testResults?.length ?? 0,
  };
}

/**
 * pytest's JUnit XML.
 *
 * Read with a regex rather than an XML parser to avoid a dependency that
 * exists only for a summary line. The `testsuite` element carries every
 * number needed as attributes, in a format pytest has emitted unchanged
 * for years.
 */
export function parseJUnit(xml) {
  const tag = /<testsuite\b[^>]*>/.exec(xml)?.[0] ?? '';
  const attr = (name) => {
    const found = new RegExp(`${name}="(\\d+)"`).exec(tag);
    return found ? Number(found[1]) : 0;
  };
  const total = attr('tests');
  const failed = attr('failures') + attr('errors');
  const skipped = attr('skipped');
  return { passed: total - failed - skipped, failed, skipped, total, files: 0 };
}

export function formatSummary(label, counts) {
  const mark = counts.failed > 0 ? '❌' : '✅';
  const parts = [`**${counts.passed} passed**`];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  const suffix = counts.files ? ` across ${counts.files} files` : '';
  return `${mark} ${label} — ${parts.join(', ')}${suffix}`;
}

export function summarise(path, label) {
  const raw = readFileSync(path, 'utf8');
  const counts = path.endsWith('.xml') ? parseJUnit(raw) : parseVitest(raw);
  return formatSummary(label, counts);
}

function main() {
  const [path, label = 'Tests'] = process.argv.slice(2);
  if (!path) {
    console.error('usage: test-summary.mjs <report file> [label]');
    return;
  }
  let line;
  try {
    line = summarise(path, label);
  } catch (error) {
    // No report file usually means the run was cancelled or the runner
    // died before writing one. Say so and move on.
    line = `⚠️ ${label} — no test report was produced (${error.message})`;
  }
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${line}\n\n`);
  console.log(line);
}

// Only run when invoked directly, so the parsers can be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
