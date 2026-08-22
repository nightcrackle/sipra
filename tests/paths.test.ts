import { describe, expect, it } from 'vitest';

import {
  baseNameOf,
  extensionOf,
  hasAudioExtension,
  isPathInside,
  MAX_FILENAME_LENGTH,
  mixExportName,
  normaliseForCompare,
  safeFileName,
  stemExportName,
  stripExtension,
  trackDirName,
} from '@shared/paths';

describe('extension helpers', () => {
  it.each(['song.wav', 'SONG.WAV', 'a/b/c.mp3', 'x.flac', 'y.m4a'])(
    'accepts %s as audio',
    (path) => {
      expect(hasAudioExtension(path)).toBe(true);
    },
  );

  it.each(['notes.txt', 'video.mp4', 'archive.zip', 'noextension', 'song.wav.txt'])(
    'rejects %s',
    (path) => {
      expect(hasAudioExtension(path)).toBe(false);
    },
  );

  it('extracts an extension', () => {
    expect(extensionOf('a/b/song.FLAC')).toBe('.flac');
    expect(extensionOf('song')).toBe('');
  });

  it('does not treat a dotted directory as an extension', () => {
    expect(extensionOf('/home/a.b/song')).toBe('');
  });

  it('extracts a base name from either separator', () => {
    expect(baseNameOf('C:\\Music\\song.wav')).toBe('song.wav');
    expect(baseNameOf('/home/me/song.wav')).toBe('song.wav');
    expect(baseNameOf('song.wav')).toBe('song.wav');
  });

  it('strips an extension', () => {
    expect(stripExtension('song.wav')).toBe('song');
    expect(stripExtension('song')).toBe('song');
    expect(stripExtension('my.song.wav')).toBe('my.song');
  });
});

describe('safeFileName', () => {
  it.each([
    ['Normal Track.wav', 'Normal Track.wav'],
    ['with/slash', 'with_slash'],
    ['back\\slash', 'back_slash'],
    ['colon:name', 'colon_name'],
    ['star*name', 'star_name'],
    ['pipe|name', 'pipe_name'],
    ['question?name', 'question_name'],
    ['  padded  ', 'padded'],
    ['trailing dots...', 'trailing dots'],
    ['multiple   spaces', 'multiple spaces'],
  ])('sanitises %s', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  it.each(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con.wav'])(
    'escapes the reserved name %s',
    (reserved) => {
      expect(safeFileName(reserved).startsWith('_')).toBe(true);
    },
  );

  it('strips control characters', () => {
    expect(safeFileName('null\u0000byte')).toBe('null_byte');
  });

  it('falls back when nothing usable survives', () => {
    expect(safeFileName('///')).toBe('track');
    expect(safeFileName('')).toBe('track');
    expect(safeFileName('   ')).toBe('track');
  });

  it('keeps a title that is only punctuation', () => {
    // `!!!` is a real band name; `///` is three stripped separators.
    expect(safeFileName('!!!')).toBe('!!!');
  });

  it('uses a custom fallback', () => {
    expect(safeFileName('', 'youtube-audio')).toBe('youtube-audio');
  });

  it('truncates an over-long name without leaving a trailing dot', () => {
    const long = safeFileName('x'.repeat(400));
    expect(long.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(long.endsWith('.')).toBe(false);
  });

  it('keeps unicode Windows allows', () => {
    expect(safeFileName('Café — Naïve')).toBe('Café — Naïve');
  });

  it('agrees with the Python implementation on the shared cases', () => {
    // `sipra_core.ingest.local.safe_filename` is tested against the same
    // table; a divergence would mean a file written under one name and
    // looked up under another.
    const shared: Array<[string, string]> = [
      ['with/slash', 'with_slash'],
      ['CON', '_CON'],
      ['///', 'track'],
      ['!!!', '!!!'],
      ['trailing dots...', 'trailing dots'],
    ];
    for (const [input, expected] of shared) {
      expect(safeFileName(input)).toBe(expected);
    }
  });
});

describe('normaliseForCompare', () => {
  it('converts separators and drops a trailing slash', () => {
    expect(normaliseForCompare('C:\\a\\b\\', 'win32')).toBe('c:/a/b');
  });

  it('collapses repeated separators', () => {
    expect(normaliseForCompare('/a//b///c', 'linux')).toBe('/a/b/c');
  });

  it('keeps a UNC prefix', () => {
    expect(normaliseForCompare('\\\\server\\share\\file', 'win32')).toBe('//server/share/file');
  });

  it('case-folds only on Windows', () => {
    expect(normaliseForCompare('/A/B', 'win32')).toBe('/a/b');
    expect(normaliseForCompare('/A/B', 'linux')).toBe('/A/B');
  });
});

describe('isPathInside', () => {
  it('accepts a direct child', () => {
    expect(isPathInside('/ws', '/ws/tracks/a.wav', 'linux')).toBe(true);
  });

  it('accepts the directory itself', () => {
    expect(isPathInside('/ws', '/ws', 'linux')).toBe(true);
  });

  it('rejects a sibling with a shared prefix', () => {
    // "/data/music-backup" must not be considered inside "/data/music".
    expect(isPathInside('/data/music', '/data/music-backup/x.wav', 'linux')).toBe(false);
  });

  it('rejects an unrelated path', () => {
    expect(isPathInside('/ws', '/etc/passwd', 'linux')).toBe(false);
  });

  it('is case-insensitive on Windows and case-sensitive elsewhere', () => {
    expect(isPathInside('C:\\Sipra', 'c:\\sipra\\tracks\\a.wav', 'win32')).toBe(true);
    expect(isPathInside('/Sipra', '/sipra/a.wav', 'linux')).toBe(false);
  });

  it('handles Windows separators on both sides', () => {
    expect(isPathInside('C:\\ws', 'C:\\ws\\tracks\\a.wav', 'win32')).toBe(true);
  });

  it('rejects empty input', () => {
    expect(isPathInside('', '/ws/a', 'linux')).toBe(false);
    expect(isPathInside('/ws', '', 'linux')).toBe(false);
  });

  it('does not resolve dot segments itself', () => {
    // Callers must resolve first; this documents that contract.
    expect(isPathInside('/ws', '/ws/../etc/passwd', 'linux')).toBe(true);
  });
});

describe('export naming', () => {
  it('names a stem export', () => {
    expect(stemExportName('Midnight Drive', 'vocals')).toBe('Midnight Drive - vocals.wav');
  });

  it('strips an extension already in the title', () => {
    expect(stemExportName('song.mp3', 'bass', '.flac')).toBe('song - bass.flac');
  });

  it('sanitises an unsafe title', () => {
    expect(stemExportName('a/b:c', 'drums')).toBe('a_b_c - drums.wav');
  });

  it('lists up to three stems in a mix name', () => {
    expect(mixExportName('Song', ['vocals', 'drums'])).toBe('Song - vocals+drums.wav');
  });

  it('counts stems instead of listing them past three', () => {
    // "Song - vocals+drums+bass+guitar+piano+other.wav" is unusable.
    expect(mixExportName('Song', ['vocals', 'drums', 'bass', 'guitar'])).toBe('Song - 4 stems.wav');
  });

  it('handles an empty stem list', () => {
    expect(mixExportName('Song', [])).toBe('Song - mix.wav');
  });

  it('builds a unique directory name for a track', () => {
    expect(trackDirName('Midnight Drive', 'abcdef12-3456')).toBe('Midnight Drive-abcdef12');
  });

  it('copes with an id containing no usable characters', () => {
    expect(trackDirName('Song', '---')).toBe('Song-track');
  });
});
