/**
 * The `sipra://` media scheme.
 *
 * Audio and peak files are streamed to the renderer through a custom
 * protocol rather than IPC, so a 40 MB stem is not copied through a
 * message channel just to be decoded.
 *
 * The renderer never sends a filesystem path. It asks for a track id and
 * an asset kind, and this resolves that against the library. A crafted URL
 * cannot reach a file the library does not already know about, and a
 * second check confirms the resolved path is inside the workspace before
 * anything is read.
 */

import path from 'node:path';

import { MEDIA_SCHEME, type MediaAssetKind } from '../../shared/ipc';
import { isPathInside } from '../../shared/paths';
import type { LibraryState, Track } from '../../shared/types';

export interface ParsedMediaRequest {
  trackId: string;
  kind: MediaAssetKind;
  stemId: string | null;
}

export class MediaRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MediaRequestError';
  }
}

const VALID_KINDS: readonly MediaAssetKind[] = ['source', 'stem', 'peaks-source', 'peaks-stem'];

/** Parse `sipra://media/<trackId>/<kind>[/<stemId>]`. */
export function parseMediaUrl(rawUrl: string): ParsedMediaRequest {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MediaRequestError('Malformed media URL', 400);
  }

  if (url.protocol !== `${MEDIA_SCHEME}:`) {
    throw new MediaRequestError('Unsupported scheme', 400);
  }
  // `sipra://media/...` puts "media" in the host and the rest in pathname.
  if (url.hostname !== 'media') {
    throw new MediaRequestError('Unknown media host', 404);
  }

  const segments = url.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  const [trackId, kind, stemId] = segments;
  if (!trackId || !kind) throw new MediaRequestError('Incomplete media URL', 400);
  if (!VALID_KINDS.includes(kind as MediaAssetKind)) {
    throw new MediaRequestError(`Unknown asset kind '${kind}'`, 404);
  }
  if ((kind === 'stem' || kind === 'peaks-stem') && !stemId) {
    throw new MediaRequestError('This asset kind needs a stem id', 400);
  }

  return {
    trackId,
    kind: kind as MediaAssetKind,
    stemId: stemId ?? null,
  };
}

/**
 * Turn a parsed request into a file path.
 *
 * Every path returned here came out of the library index, was resolved,
 * and was checked to be inside the workspace.
 */
export function resolveMediaPath(
  request: ParsedMediaRequest,
  state: LibraryState,
  workspaceDir: string,
): { filePath: string; contentType: string } {
  const track: Track | undefined = state.tracks.find(
    (candidate) => candidate.id === request.trackId,
  );
  if (!track) throw new MediaRequestError('Unknown track', 404);

  let filePath: string | undefined;
  switch (request.kind) {
    case 'source':
      filePath = track.sourcePath;
      break;
    case 'peaks-source':
      filePath = track.sourcePeaksPath;
      break;
    case 'stem':
      filePath = track.stems.find((stem) => stem.id === request.stemId)?.audioPath;
      break;
    case 'peaks-stem':
      filePath = track.stems.find((stem) => stem.id === request.stemId)?.peaksPath;
      break;
    default:
      throw new MediaRequestError('Unknown asset kind', 404);
  }

  if (!filePath) throw new MediaRequestError('Unknown asset', 404);

  // Both sides are resolved, not just the asset.
  //
  // Resolving one and not the other means comparing paths in two different
  // forms, and on Windows those forms differ enough to matter: `resolve`
  // turns a root-relative path into a drive-qualified one, so a child that
  // genuinely sits inside the parent no longer looks like it does. In
  // production both arrive absolute and native and the asymmetry never
  // showed; it took a Windows test run to expose it.
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(filePath);
  if (!isPathInside(root, resolved)) {
    throw new MediaRequestError('Asset is outside the workspace', 403);
  }

  return { filePath: resolved, contentType: contentTypeFor(resolved) };
}

export function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.m4a':
    case '.aac':
      return 'audio/mp4';
    case '.aiff':
    case '.aif':
      return 'audio/aiff';
    case '.speaks':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}
