#!/usr/bin/env node
/**
 * Point the README's build badges at a real repository.
 *
 * A badge URL contains the owner and repository name, which cannot be
 * known before the project is pushed anywhere. Rather than leave three
 * placeholder URLs to be edited by hand — where getting one of them wrong
 * produces a badge that is silently blank forever — this rewrites all of
 * them at once and reports what it changed.
 *
 *     npm run set-repo -- your-username/sipra
 *
 * With no argument it reads the `origin` remote, which is right whenever
 * the repository has already been pushed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = path.join(root, 'README.md');

/** `nightcrackle/sipra` from any of the shapes a git remote can take. */
export function parseRemote(url) {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/, '');
  const match =
    /^git@[^:]+:(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(cleaned) ??
    /^(?:https?|ssh):\/\/[^/]+\/(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(cleaned);
  if (!match?.groups) return null;
  return `${match.groups.owner}/${match.groups.repo}`;
}

/** Valid as a GitHub `nightcrackle/sipra` pair. */
export function isRepoSlug(value) {
  return /^[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9][A-Za-z0-9-_.]*$/.test(value ?? '');
}

/**
 * Rewrite every github.com badge and link to point at `slug`.
 *
 * Matches whatever owner and repository are there now, so this is safe to
 * run repeatedly and safe to run after a rename — not only against the
 * original placeholder.
 */
export function rewrite(markdown, slug) {
  return markdown.replace(
    /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9][A-Za-z0-9-_.]*\/actions/g,
    `https://github.com/${slug}/actions`,
  );
}

function remoteSlug() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRemote(url);
  } catch {
    return null;
  }
}

function main() {
  const slug = process.argv[2] ?? remoteSlug();
  if (!isRepoSlug(slug)) {
    console.error(
      slug
        ? `Not a valid nightcrackle/sipra: ${slug}`
        : 'No repository given and no origin remote found.\n' +
            'Usage: npm run set-repo -- your-username/sipra',
    );
    process.exitCode = 1;
    return;
  }

  const before = readFileSync(README, 'utf8');
  const after = rewrite(before, slug);
  if (before === after) {
    console.log(`Badges already point at ${slug}.`);
    return;
  }
  writeFileSync(README, after);
  const count = (after.match(/actions\/workflows/g) ?? []).length;
  console.log(`Pointed ${count} badge links at ${slug}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
