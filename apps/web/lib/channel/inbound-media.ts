import type Anthropic from '@anthropic-ai/sdk';
import { attachmentContentBlock } from '~/lib/coach/attachment-blocks';

/**
 * A Linq attachment, small enough to store on the inbound row and re-drive.
 *
 * Bytes are never stored. A photo is fetched when the coach runs, and only then.
 * A video or a file is named so the model can write the reply; it is not downloaded.
 */

export type InboundMediaKind = 'image' | 'video' | 'file';

export interface InboundMediaPart {
  kind: InboundMediaKind;
  /** https only. Anything else is stored as null and not fetched. */
  url: string | null;
  mime: string | null;
}

export interface ReadInboundMedia {
  blocks: Anthropic.ContentBlockParam[];
  /** What this turn carried that the model did not see as bytes. */
  unwatched: Array<{ kind: InboundMediaKind }>;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)(?:$|\?)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(?:$|\?)/i;
const IMAGE_BLOCK_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Anthropic's image block cap, with room under it. */
const IMAGE_BYTE_CAP = 4_000_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PARTS = 8;

export function httpsMediaUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

export function classifyInboundMedia(
  mime: string | null,
  url: string | null,
  filename: string | null,
): InboundMediaKind {
  const normalized = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (IMAGE_EXT.test(filename ?? '') || IMAGE_EXT.test(url ?? '')) return 'image';
  if (VIDEO_EXT.test(filename ?? '') || VIDEO_EXT.test(url ?? '')) return 'video';
  return 'file';
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** One non-text Linq part. The caller has already skipped text. */
export function mediaPartFromLinq(part: Record<string, unknown>): InboundMediaPart {
  const url = firstString(part.url, part.media_url);
  const mime = firstString(part.mime_type, part.mime, part.content_type);
  const filename = firstString(part.filename, part.name);
  const normalized = mime ? mime.toLowerCase().split(';')[0]?.trim() || null : null;
  return {
    kind: classifyInboundMedia(normalized, url, filename),
    url: httpsMediaUrl(url),
    mime: normalized,
  };
}

/** The shape written on the inbound row. Drops anything that is not https. */
export function persistableMedia(
  parts: readonly InboundMediaPart[] | undefined,
): InboundMediaPart[] | null {
  if (!parts || parts.length === 0) return null;
  return parts.slice(0, MAX_PARTS).map((part) => ({
    kind: part.kind === 'image' || part.kind === 'video' ? part.kind : 'file',
    url: httpsMediaUrl(part.url),
    mime: part.mime && part.mime.length <= 80 ? part.mime : null,
  }));
}

export function inboundMediaFromStored(value: unknown): InboundMediaPart[] {
  if (!Array.isArray(value)) return [];
  const out: InboundMediaPart[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const kind =
      row.kind === 'image' || row.kind === 'video' || row.kind === 'file' ? row.kind : null;
    if (!kind) continue;
    out.push({
      kind,
      url: typeof row.url === 'string' ? httpsMediaUrl(row.url) : null,
      mime: typeof row.mime === 'string' ? row.mime : null,
    });
  }
  return out;
}

function sniffedMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function headerMime(header: string | null): string | null {
  if (!header) return null;
  const mime = header.toLowerCase().split(';')[0]?.trim() ?? '';
  return mime || null;
}

/**
 * Fetch the images on this turn into model blocks. Videos and files are not
 * fetched. A failed fetch is named in the return (unwatched), never thrown,
 * and the URL is not logged.
 */
export async function readInboundMedia(
  parts: readonly InboundMediaPart[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReadInboundMedia> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const unwatched: Array<{ kind: InboundMediaKind }> = [];
  for (const part of parts.slice(0, MAX_PARTS)) {
    if (part.kind !== 'image') {
      unwatched.push({ kind: part.kind });
      continue;
    }
    const url = httpsMediaUrl(part.url);
    if (!url) {
      unwatched.push({ kind: 'image' });
      continue;
    }
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // A stub Response has an empty url. A real redirect that lands off https does not.
      const finalUrl = response.url ? httpsMediaUrl(response.url) : url;
      if (!response.ok || !finalUrl) {
        unwatched.push({ kind: 'image' });
        continue;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > IMAGE_BYTE_CAP) {
        unwatched.push({ kind: 'image' });
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_BYTE_CAP) {
        unwatched.push({ kind: 'image' });
        continue;
      }
      const mime =
        sniffedMime(bytes) ?? headerMime(response.headers.get('content-type')) ?? part.mime;
      if (!mime || !IMAGE_BLOCK_MIMES.has(mime)) {
        unwatched.push({ kind: 'image' });
        continue;
      }
      blocks.push(attachmentContentBlock(bytes, mime));
    } catch (err) {
      console.info(
        { reason: 'fetch_failed', err: err instanceof Error ? err.name : 'unknown' },
        'inbound media: image unread',
      );
      unwatched.push({ kind: 'image' });
    }
  }
  return { blocks, unwatched };
}
