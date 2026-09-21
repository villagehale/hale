import { parseEmailAddress } from './address';

/**
 * WHO REALLY SENT THE DOCUMENT — reading the original sender, subject and body out of a
 * message a parent forwarded (VIL-352 rung 3a).
 *
 * This is the mirror image of reply-extract.ts and exists for the same reason that module
 * does. On the reply door, everything below a forwarded-message banner is history Hale
 * must never re-read as a new turn, so `extractReply` hard-cuts there. On THIS door the
 * thing below the banner is the entire point, and the `From` above the banner is the
 * parent's own mailbox rather than the school's. Running the reply door's extractor here
 * would return an empty string every time (asserted in forward-parse.test.ts).
 *
 * Deterministic and model-free, for the same reason reply-extract.ts is: forwarding is a
 * mechanical convention of a handful of clients, and a probabilistic reader would fail
 * differently on every message.
 *
 * WHAT IT REFUSES TO GUESS. A filter auto-forward carries no banner at all — the school's
 * message arrives verbatim — and that is reported honestly as `originalFrom: null` rather
 * than dressed up with the envelope sender. The caller falls back to the webhook's own
 * `From`, and the allowlist key is that domain, so an honest null costs nothing and an
 * invented sender would cost a family the wrong allowlist entry.
 */

export interface ForwardedMessage {
  /** The original sender's address, lowercased, or null when the forward carries no
   * banner to read one from. */
  originalFrom: string | null;
  originalSubject: string | null;
  /** The document itself, trimmed. The whole text when there is no banner. */
  body: string;
}

const BANNER = /^(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:|-{2,}\s*original message\s*-{2,})$/i;
const HEADER_LINE = /^(from|sent|date|to|cc|bcc|subject|reply-to):\s*(.*)$/i;
const FROM_HEADER = /^from:/i;

/** A slab is a real header block only when it is several headers deep AND names a
 * sender. Prose that happens to contain an address never reaches three of these. */
const HEADER_SLAB_MIN_LINES = 3;

interface HeaderBlock {
  from: string | null;
  subject: string | null;
  /** The index of the first line after the block. */
  end: number;
}

/** Reads the header block starting at `start`, or null when there isn't one there. */
function readHeaders(lines: readonly string[], start: number): HeaderBlock | null {
  let index = start;
  let count = 0;
  let sawFrom = false;
  let from: string | null = null;
  let subject: string | null = null;

  while (index < lines.length) {
    const line = lines[index] as string;
    if (!line.trim()) {
      // One blank line inside the block is a client's formatting; a blank after at least
      // one header ends it.
      if (count === 0) {
        index += 1;
        continue;
      }
      index += 1;
      break;
    }
    const match = HEADER_LINE.exec(line);
    if (!match) break;

    count += 1;
    const name = (match[1] as string).toLowerCase();
    const value = (match[2] as string).trim();
    if (name === 'from') {
      sawFrom = true;
      from = parseEmailAddress(value)?.address ?? null;
    }
    if (name === 'subject') subject = value || null;
    index += 1;
  }

  if (count < HEADER_SLAB_MIN_LINES || !sawFrom) return null;
  return { from, subject, end: index };
}

export function parseForwardedMessage(text: string): ForwardedMessage {
  const lines = text.split(/\r?\n/);

  const bannerIndex = lines.findIndex((line) => BANNER.test(line.trim()));
  // With no banner, a header slab is only a forward when it opens the message. Anywhere
  // else it is prose, and a quoted address is not a sender.
  const headerStart = bannerIndex === -1 ? firstNonBlank(lines) : bannerIndex + 1;
  const headers =
    bannerIndex === -1 && !FROM_HEADER.test((lines[headerStart] ?? '').trim())
      ? null
      : readHeaders(lines, headerStart);

  if (!headers) {
    return { originalFrom: null, originalSubject: null, body: text.trim() };
  }

  return {
    originalFrom: headers.from,
    originalSubject: headers.subject,
    body: lines.slice(headers.end).join('\n').trim(),
  };
}

function firstNonBlank(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.trim());
  return index === -1 ? lines.length : index;
}
