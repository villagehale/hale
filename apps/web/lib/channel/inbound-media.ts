import type Anthropic from '@anthropic-ai/sdk';
import { linqVoiceMemosEnabled } from '~/lib/channel/linq/config';
import { createPublicFetch } from '~/lib/channel/public-fetch';
import { type CoachContact, MAX_CONTACT_CARDS, parseContactCards } from '~/lib/channel/vcard';
import { attachmentContentBlock } from '~/lib/coach/attachment-blocks';

/**
 * A Linq attachment, small enough to store on the inbound row and re-drive.
 *
 * Bytes are never stored. A photo is fetched when the coach runs, and only then.
 * A `.vcf` (`contact`, VIL-482) is fetched then too, and read into name and number —
 * the card itself is not handed to the model. A PDF (`file`, VIL-413) is fetched
 * into a document block only while INBOUND_PHOTO_FACTS_ENABLED is lit. A video, a
 * voice memo, or any other file is named so the model can write the reply; it is not
 * downloaded. `audio` (VIL-476) exists only while LINQ_VOICE_MEMOS_ENABLED is `true`;
 * dark, audio reads as `file`, exactly as before.
 */

export type InboundMediaKind = 'image' | 'video' | 'audio' | 'file' | 'contact';

const KINDS: readonly InboundMediaKind[] = ['image', 'video', 'audio', 'file', 'contact'];

export interface InboundMediaPart {
  kind: InboundMediaKind;
  /** https only. Anything else is stored as null and not fetched. */
  url: string | null;
  mime: string | null;
}

export interface ReadInboundMedia {
  blocks: Anthropic.ContentBlockParam[];
  /** What this turn carried that the model did not see as bytes. A voice memo that was
   * transcribed (VIL-495) carries the parent's words as `heard`. */
  unwatched: Array<{ kind: InboundMediaKind; heard?: string }>;
  /** Contact cards read off `.vcf` parts. Empty when this turn had none. */
  contacts: CoachContact[];
  /** A file held more cards than `contacts` keeps. */
  contactsTruncated: boolean;
}

/** VIL-495 · the words in one voice memo, or null when it could not be heard. */
export type HearVoiceMemo = (part: InboundMediaPart & { url: string }) => Promise<string | null>;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)(?:$|\?)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(?:$|\?)/i;
const AUDIO_EXT = /\.(m4a|mp3|aac|caf|wav|aiff?|amr)(?:$|\?)/i;
const CONTACT_EXT = /\.vcf(?:$|[?#])/i;
const CONTACT_MIMES = new Set([
  'text/vcard',
  'text/x-vcard',
  'text/directory',
  'application/vcard',
]);
const IMAGE_BLOCK_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Anthropic's image block cap, with room under it. */
const IMAGE_BYTE_CAP = 4_000_000;
/** A contact photo can make a `.vcf` large. The parser drops the photo itself. */
const CONTACT_BYTE_CAP = 2_000_000;
/** VIL-413 · the same ceiling a photo has. */
const DOCUMENT_BYTE_CAP = 4_000_000;
const PDF_EXT = /\.pdf(?:$|[?#])/i;
const PDF_MIME = 'application/pdf';
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

/**
 * Devin SEC_0001: a `.vcf` URL comes from the webhook payload, so the fetch must not
 * reach a loopback, private, link-local, or metadata host. IP literals in those ranges
 * and internal-looking names are refused. Redirects are followed by hand so every hop
 * is checked again.
 */
export function publicMediaUrl(raw: string | null | undefined): string | null {
  const url = httpsMediaUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) {
    return null;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return null;
    }
    return url;
  }
  if (host.includes(':')) {
    // Any IPv6 literal: loopback, ULA, link-local, and v4-mapped forms are all refused;
    // a real media host is a DNS name.
    return null;
  }
  // Numeric-looking hosts that are not dotted quads (e.g. 2130706433, 0x7f.1) are refused.
  if (/^[\d.x]+$/i.test(host) || /^0x/i.test(host)) return null;
  return url;
}

const MAX_CONTACT_REDIRECTS = 3;

/** Fetch-shaped, so a test can hand in a stub; production pins the vetted address. */
export type ContactFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

const publicContactFetch: ContactFetch = createPublicFetch({ maxBytes: CONTACT_BYTE_CAP });
const publicDocumentFetch: ContactFetch = createPublicFetch({ maxBytes: DOCUMENT_BYTE_CAP });

export function classifyInboundMedia(
  mime: string | null,
  url: string | null,
  filename: string | null,
  voiceMemos: boolean = linqVoiceMemosEnabled(),
): InboundMediaKind {
  const normalized = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (voiceMemos && normalized.startsWith('audio/')) return 'audio';
  if (CONTACT_MIMES.has(normalized)) return 'contact';
  if (IMAGE_EXT.test(filename ?? '') || IMAGE_EXT.test(url ?? '')) return 'image';
  if (VIDEO_EXT.test(filename ?? '') || VIDEO_EXT.test(url ?? '')) return 'video';
  if (voiceMemos && (AUDIO_EXT.test(filename ?? '') || AUDIO_EXT.test(url ?? ''))) return 'audio';
  if (CONTACT_EXT.test(filename ?? '') || CONTACT_EXT.test(url ?? '')) return 'contact';
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
    kind: KINDS.includes(part.kind) ? part.kind : 'file',
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
    const kind = KINDS.includes(row.kind as InboundMediaKind)
      ? (row.kind as InboundMediaKind)
      : null;
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

function sniffedPdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
}

function looksLikePdf(part: InboundMediaPart): boolean {
  return (part.mime ?? '').toLowerCase() === PDF_MIME || PDF_EXT.test(part.url ?? '');
}

export interface ReadInboundMediaOptions {
  /**
   * VIL-413 · fetch a PDF file into a document block. Off (the default): files stay
   * named and unwatched, so a dark turn downloads nothing new.
   */
  documents?: boolean;
  /** The PDF fetch. Production pins the vetted address, like the `.vcf` fetch. */
  documentFetch?: ContactFetch;
}

/**
 * Fetch the images on this turn into model blocks, `.vcf` parts into contact
 * fields, and hear its voice memos when a `hear` port is given (VIL-495). Videos
 * and other files are not fetched, except a PDF while `documents` is on. A failed
 * fetch is named in the return (unwatched), never thrown, and the URL is not logged.
 */
export async function readInboundMedia(
  parts: readonly InboundMediaPart[],
  fetchImpl: typeof fetch = fetch,
  hear?: HearVoiceMemo,
  contactFetch: ContactFetch = publicContactFetch,
  options: ReadInboundMediaOptions = {},
): Promise<ReadInboundMedia> {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const unwatched: Array<{ kind: InboundMediaKind; heard?: string }> = [];
  const contacts: CoachContact[] = [];
  let contactsTruncated = false;
  for (const part of parts.slice(0, MAX_PARTS)) {
    if (part.kind === 'contact') {
      const read = await readContactPart(part, contactFetch);
      if (read.truncated) contactsTruncated = true;
      if (read.cards.length === 0) {
        unwatched.push({ kind: 'contact' });
        continue;
      }
      for (const card of read.cards) {
        if (contacts.length >= MAX_CONTACT_CARDS) {
          contactsTruncated = true;
          break;
        }
        contacts.push(card);
      }
      continue;
    }
    if (part.kind === 'audio') {
      const url = httpsMediaUrl(part.url);
      const heard = hear && url ? await hear({ ...part, url }) : null;
      unwatched.push(heard ? { kind: 'audio', heard } : { kind: 'audio' });
      continue;
    }
    if (options.documents === true && part.kind === 'file' && looksLikePdf(part)) {
      const block = await readDocumentPart(part, options.documentFetch ?? publicDocumentFetch);
      if (block) blocks.push(block);
      else unwatched.push({ kind: 'file' });
      continue;
    }
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
  return { blocks, unwatched, contacts, contactsTruncated };
}

const EMPTY_CONTACTS = { cards: [], truncated: false };

async function readContactPart(
  part: InboundMediaPart,
  fetchImpl: ContactFetch,
): Promise<{ cards: CoachContact[]; truncated: boolean }> {
  try {
    const bytes = await fetchPublicMedia(part, fetchImpl, CONTACT_BYTE_CAP, unreadContact);
    if (!bytes) return EMPTY_CONTACTS;
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const parsed = parseContactCards(text);
    if (parsed.cards.length === 0) {
      unreadContact('unreadable');
      return EMPTY_CONTACTS;
    }
    if (parsed.truncated) {
      console.info({ reason: 'truncated' }, 'inbound media: contact truncated');
    }
    return parsed;
  } catch (err) {
    console.info(
      { reason: 'fetch_failed', err: err instanceof Error ? err.name : 'unknown' },
      'inbound media: contact unread',
    );
    return EMPTY_CONTACTS;
  }
}

/** VIL-413 · a PDF the parent sent, as a document block. Null is already named in the log. */
async function readDocumentPart(
  part: InboundMediaPart,
  fetchImpl: ContactFetch,
): Promise<Anthropic.ContentBlockParam | null> {
  try {
    const bytes = await fetchPublicMedia(part, fetchImpl, DOCUMENT_BYTE_CAP, unreadDocument);
    if (!bytes) return null;
    // The bytes decide, not a header: a non-PDF sent as a document block fails the
    // whole model call, not just this attachment.
    if (!sniffedPdf(bytes)) {
      unreadDocument('not_pdf');
      return null;
    }
    return attachmentContentBlock(bytes, PDF_MIME);
  } catch (err) {
    console.info(
      { reason: 'fetch_failed', err: err instanceof Error ? err.name : 'unknown' },
      'inbound media: document unread',
    );
    return null;
  }
}

/**
 * GET one webhook-supplied URL (Devin SEC_0001, #985): only a public https host, every
 * redirect hop checked again, and the body capped. Null is a refusal already named
 * through `unread`; a thrown error is the caller's to name.
 */
async function fetchPublicMedia(
  part: InboundMediaPart,
  fetchImpl: ContactFetch,
  byteCap: number,
  unread: (reason: string) => void,
): Promise<Buffer | null> {
  const first = publicMediaUrl(part.url);
  if (!first) {
    unread(httpsMediaUrl(part.url) ? 'private_host' : 'not_https');
    return null;
  }
  let url: string = first;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response = await fetchImpl(url, { redirect: 'manual', signal });
  for (let hop = 0; response.status >= 300 && response.status < 400; hop++) {
    const location = response.headers.get('location');
    const next: string | null =
      location && hop < MAX_CONTACT_REDIRECTS
        ? publicMediaUrl(new URL(location, url).toString())
        : null;
    if (!next) {
      unread('redirect');
      return null;
    }
    url = next;
    response = await fetchImpl(url, { redirect: 'manual', signal });
  }
  // Belt and braces: a fetch that followed anyway must still land on a public https host.
  if (response.url && !publicMediaUrl(response.url)) {
    unread('redirect');
    return null;
  }
  if (!response.ok) {
    unread('http_status');
    return null;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > byteCap) {
    unread('too_large');
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > byteCap) {
    unread(bytes.byteLength === 0 ? 'empty' : 'too_large');
    return null;
  }
  return bytes;
}

function unreadContact(reason: string): void {
  console.info({ reason }, 'inbound media: contact unread');
}

function unreadDocument(reason: string): void {
  console.info({ reason }, 'inbound media: document unread');
}
