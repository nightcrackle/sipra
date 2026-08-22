/**
 * Input sanitising for IPC.
 *
 * Kept in its own module, free of Electron imports, so the rules can be
 * unit tested. These functions are the boundary between a sandboxed
 * renderer and the main process's filesystem access, which makes them
 * worth testing properly rather than eyeballing.
 */

const EDITABLE_TRACK_FIELDS = ['title', 'artist', 'tags', 'notes', 'folderId'] as const;

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 48;

/**
 * Whitelist the fields the renderer may change on a track.
 *
 * Deliberately a whitelist rather than a merge: a renderer bug that
 * spread a whole track object into a patch must not be able to rewrite
 * `trackDir` or `sourcePath`, which would point the media resolver at a
 * path the library never produced.
 */
export function pickTrackPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const source = patch as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of EDITABLE_TRACK_FIELDS) {
    if (!(key in source)) continue;
    result[key] = source[key];
  }

  if ('title' in result) {
    const title = typeof result.title === 'string' ? result.title.trim() : '';
    result.title = title.slice(0, MAX_TITLE_LENGTH) || 'Untitled';
  }

  if ('artist' in result) {
    result.artist =
      typeof result.artist === 'string' && result.artist.trim()
        ? result.artist.trim().slice(0, MAX_TITLE_LENGTH)
        : null;
  }

  if ('notes' in result) {
    result.notes = typeof result.notes === 'string' ? result.notes.slice(0, MAX_NOTES_LENGTH) : '';
  }

  if ('tags' in result) {
    result.tags = Array.isArray(result.tags)
      ? Array.from(
          new Set(
            (result.tags as unknown[])
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim().slice(0, MAX_TAG_LENGTH))
              .filter(Boolean),
          ),
        ).slice(0, MAX_TAGS)
      : [];
  }

  if ('folderId' in result && typeof result.folderId !== 'string' && result.folderId !== null) {
    delete result.folderId;
  }

  return result;
}
