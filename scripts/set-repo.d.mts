/**
 * Types for the badge-repointing script.
 *
 * Plain `.mjs` so it runs with no build step; declared here so its tests
 * are type-checked.
 */

/** `owner/repo` from a git remote URL, or null if it is not one. */
export function parseRemote(url: string | undefined | null): string | null;

/** Whether a string is usable as a GitHub `owner/repo` pair. */
export function isRepoSlug(value: string | undefined | null): boolean;

/** Repoint every GitHub Actions URL in the given markdown at `slug`. */
export function rewrite(markdown: string, slug: string): string;
