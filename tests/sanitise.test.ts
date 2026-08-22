import { describe, expect, it } from 'vitest';

import {
  MAX_NOTES_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  pickTrackPatch,
} from '../electron/ipc/sanitise';

describe('pickTrackPatch', () => {
  it('keeps the editable fields', () => {
    const patch = pickTrackPatch({
      title: 'New title',
      artist: 'Someone',
      tags: ['a'],
      notes: 'hello',
      folderId: 'f1',
    });
    expect(patch).toEqual({
      title: 'New title',
      artist: 'Someone',
      tags: ['a'],
      notes: 'hello',
      folderId: 'f1',
    });
  });

  it('drops fields that would repoint the media resolver', () => {
    // This is the whole reason the function exists.
    const patch = pickTrackPatch({
      title: 'ok',
      trackDir: 'C:\\Windows',
      sourcePath: '/etc/passwd',
      stems: [{ id: 'vocals', audioPath: '/etc/shadow' }],
      id: 'other-track',
      deletedAt: null,
    });
    expect(patch).toEqual({ title: 'ok' });
  });

  it('returns nothing for a non-object', () => {
    for (const junk of [null, undefined, 42, 'text', [1, 2]]) {
      expect(pickTrackPatch(junk)).toEqual({});
    }
  });

  it('returns nothing for an empty patch', () => {
    expect(pickTrackPatch({})).toEqual({});
  });

  it('trims a title and refuses to leave it empty', () => {
    expect(pickTrackPatch({ title: '   ' }).title).toBe('Untitled');
    expect(pickTrackPatch({ title: '  Song  ' }).title).toBe('Song');
  });

  it('coerces a non-string title', () => {
    expect(pickTrackPatch({ title: 42 }).title).toBe('Untitled');
  });

  it('caps title length', () => {
    expect(String(pickTrackPatch({ title: 'x'.repeat(500) }).title)).toHaveLength(
      MAX_TITLE_LENGTH,
    );
  });

  it('normalises an empty artist to null', () => {
    expect(pickTrackPatch({ artist: '  ' }).artist).toBeNull();
    expect(pickTrackPatch({ artist: 123 }).artist).toBeNull();
  });

  it('caps notes length', () => {
    expect(String(pickTrackPatch({ notes: 'x'.repeat(9999) }).notes)).toHaveLength(
      MAX_NOTES_LENGTH,
    );
  });

  it('coerces non-string notes to empty', () => {
    expect(pickTrackPatch({ notes: { a: 1 } }).notes).toBe('');
  });

  it('filters, trims and deduplicates tags', () => {
    const tags = pickTrackPatch({ tags: ['  a  ', 'a', 'b', '', 5, null] }).tags;
    expect(tags).toEqual(['a', 'b']);
  });

  it('caps the number and length of tags', () => {
    const tags = pickTrackPatch({
      tags: [
        'y'.repeat(200),
        ...Array.from({ length: MAX_TAGS + 20 }, (_v, i) => `tag-${i}`),
      ],
    }).tags as string[];
    expect(tags.length).toBeLessThanOrEqual(MAX_TAGS);
    expect(tags[0]).toHaveLength(MAX_TAG_LENGTH);
  });

  it('coerces non-array tags to an empty list', () => {
    expect(pickTrackPatch({ tags: 'not an array' }).tags).toEqual([]);
  });

  it('accepts null as a folder id for unfiling', () => {
    expect(pickTrackPatch({ folderId: null })).toEqual({ folderId: null });
  });

  it('drops a folder id of the wrong type', () => {
    expect(pickTrackPatch({ folderId: 42 })).toEqual({});
  });
});
