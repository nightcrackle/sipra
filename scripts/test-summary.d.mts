/**
 * Types for the CI summary script.
 *
 * The script itself is plain `.mjs` so a GitHub runner can execute it with
 * no build step. This declaration exists so the tests that cover it are
 * type-checked like everything else.
 */

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Test files, or 0 when the report does not say. */
  files: number;
}

/** Vitest's JSON report, as an object or as the raw text. */
export function parseVitest(json: unknown): TestCounts;

/** pytest's JUnit XML. */
export function parseJUnit(xml: string): TestCounts;

/** One line, marked with a tick or a cross. */
export function formatSummary(label: string, counts: TestCounts): string;

/** Read a report from disk and format it. Throws if the file is missing. */
export function summarise(path: string, label: string): string;
