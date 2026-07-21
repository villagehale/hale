/**
 * RFC 5545 (iCalendar) serializer for the family's read-only calendar subscription
 * feed (VIL-219). No ICS library exists in the tree, so the format is hand-rolled to
 * the spec: CRLF line endings, 75-octet line folding, and TEXT-value escaping.
 *
 * Every instant is emitted in the UTC form (`YYYYMMDDTHHMMSSZ`), so the feed carries
 * no VTIMEZONE and each calendar client localizes to the viewer's own zone. This
 * module is PURE — no I/O, no db. `loadIcsFeed` (ics-feed.ts) does the teen gate and
 * hands in events that are already redaction-safe and surname-free (rule #1); this
 * serializer escapes but never filters.
 */

/** One event as serialized into a VEVENT. `title`/`location` are already teen-gated
 * and surname-free by the caller (rule #1); this module only escapes them. */
export interface IcsEvent {
  /** family_events.id — becomes the VEVENT UID as `<id>@hale`. */
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
}

export interface GenerateIcsOptions {
  /** DTSTAMP for every VEVENT (object generation time). Defaults to now. */
  now?: Date;
  /** PRODID value. Defaults to the Hale identifier. */
  prodId?: string;
}

const DEFAULT_PRODID = '-//Hale//Calendar Feed//EN';

/** Max octets per serialized content line before folding (RFC 5545 §3.1). */
const MAX_LINE_OCTETS = 75;

/**
 * Formats an instant as the RFC 5545 UTC date-time form `YYYYMMDDTHHMMSSZ`. Derived
 * from the ISO string (always UTC), stripping the separators and the millisecond
 * fraction the form does not carry.
 */
function formatUtc(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Escapes a TEXT value per RFC 5545 §3.3.11. Backslash is escaped FIRST so the
 * escapes added for `;` `,` and newline are not themselves re-escaped.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds one content line to ≤75 octets (RFC 5545 §3.1): a CRLF followed by a single
 * space splits long lines. Octets are counted as UTF-8 bytes and never split inside a
 * multi-byte character (iteration is per code point). A continuation line's leading
 * space consumes one octet of its budget.
 */
function foldLine(line: string): string {
  const segments: string[] = [];
  let segment = '';
  let segmentOctets = 0;
  let isContinuation = false;

  for (const char of line) {
    const charOctets = Buffer.byteLength(char, 'utf8');
    const budget = isContinuation ? MAX_LINE_OCTETS - 1 : MAX_LINE_OCTETS;
    if (segmentOctets + charOctets > budget) {
      segments.push(segment);
      segment = '';
      segmentOctets = 0;
      isContinuation = true;
    }
    segment += char;
    segmentOctets += charOctets;
  }
  segments.push(segment);

  return segments.join('\r\n ');
}

/**
 * Serializes a family's events to a single RFC 5545 VCALENDAR string. CRLF-terminated,
 * folded, and TEXT-escaped. The caller has already applied the teen gate and dropped
 * deleted rows — this renders exactly what it is given, in order.
 */
export function generateFamilyIcs(events: IcsEvent[], options: GenerateIcsOptions = {}): string {
  const dtstamp = formatUtc(options.now ?? new Date());
  const prodId = options.prodId ?? DEFAULT_PRODID;

  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN'];

  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@hale`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${formatUtc(event.startsAt)}`);
    if (event.endsAt !== null) {
      lines.push(`DTEND:${formatUtc(event.endsAt)}`);
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.location !== null) {
      lines.push(`LOCATION:${escapeText(event.location)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
