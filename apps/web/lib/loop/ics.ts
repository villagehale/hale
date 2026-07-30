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
 * The stable UID for a family_events row. Feed and per-event invite emit the SAME
 * value, so a client holding both sees one event with two views of it rather than a
 * duplicate — and a later invite (higher SEQUENCE) supersedes the earlier one.
 */
function eventUid(familyEventId: string): string {
  return `${familyEventId}@hale`;
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
    lines.push(`UID:${eventUid(event.id)}`);
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

// ── Per-event invites (VIL-249 · M13) ────────────────────────────────────────

/** The iTIP methods an ADDRESSED invite uses: the request, and its withdrawal. A
 * downloaded file is not addressed to anyone and uses PUBLISH instead. */
export type IcsMethod = 'REQUEST' | 'CANCEL';

/**
 * One event as an iTIP object. Every TEXT value is ALREADY redaction-treated by the
 * caller (ics-invite.ts) to the level of the channel carrying it — this module escapes
 * but never filters, exactly as the feed serializer does.
 */
export interface IcsInviteEvent {
  /** family_events.id — the UID anchor across every revision of this event. */
  id: string;
  summary: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  description: string | null;
  /** RFC 5545 SEQUENCE: the event's revision. A client supersedes a stored copy of
   * the same UID only when the incoming SEQUENCE is greater or equal. */
  sequence: number;
}

export interface GenerateEventPublishOptions {
  /** ORGANIZER — Hale's send address (the address the invite is sent FROM). */
  organizerEmail: string;
  organizerName?: string;
  now?: Date;
  prodId?: string;
}

export interface GenerateEventInviteOptions extends GenerateEventPublishOptions {
  /** ATTENDEE — the addressed recipient. RFC 5546 §3.2.2 requires at least one on a
   * REQUEST, and Gmail/Outlook only render the add-to-calendar card when the reader
   * is one. A PUBLISH carries none (§3.2.1 — it is addressed to nobody). */
  attendeeEmail: string;
}

const DEFAULT_INVITE_PRODID = '-//Hale//Calendar Invite//EN';
const DEFAULT_ORGANIZER_NAME = 'Hale';

function serializeIcsEvent(
  event: IcsInviteEvent,
  method: IcsMethod | 'PUBLISH',
  options: GenerateEventPublishOptions & { attendeeEmail?: string },
): string {
  const dtstamp = formatUtc(options.now ?? new Date());
  const organizerName = options.organizerName ?? DEFAULT_ORGANIZER_NAME;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${options.prodId ?? DEFAULT_INVITE_PRODID}`,
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${eventUid(event.id)}`,
    `DTSTAMP:${dtstamp}`,
    `SEQUENCE:${event.sequence}`,
    `ORGANIZER;CN=${organizerName}:mailto:${options.organizerEmail}`,
  ];

  if (options.attendeeEmail !== undefined) {
    const params =
      method === 'REQUEST'
        ? 'CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE'
        : 'CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT';
    lines.push(`ATTENDEE;${params}:mailto:${options.attendeeEmail}`);
  }
  lines.push(`DTSTART:${formatUtc(event.startsAt)}`);

  if (event.endsAt !== null) {
    lines.push(`DTEND:${formatUtc(event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.location !== null) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }
  if (event.description !== null) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }
  lines.push(method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED');
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * The single-event invite (METHOD:REQUEST) a parent can accept straight from an email
 * — the zero-OAuth add-to-calendar path. Re-issuing the same event with a higher
 * SEQUENCE updates the client's copy in place, because the UID is stable per
 * family_events row.
 */
export function generateEventInvite(
  event: IcsInviteEvent,
  options: GenerateEventInviteOptions,
): string {
  return serializeIcsEvent(event, 'REQUEST', options);
}

/**
 * The same event as a plain downloadable calendar file (METHOD:PUBLISH) — what a link
 * serves. It is addressed to nobody, so it carries no ATTENDEE (RFC 5546 §3.2.1); the
 * UID is still the event's, so importing it updates the client's copy rather than
 * adding a second one.
 */
export function generateEventPublish(
  event: IcsInviteEvent,
  options: GenerateEventPublishOptions,
): string {
  return serializeIcsEvent(event, 'PUBLISH', options);
}

/**
 * The withdrawal (METHOD:CANCEL) of a previously sent invite. Same UID, and the caller
 * must supply a SEQUENCE above the last REQUEST's — a client ignores a cancellation
 * that does not supersede the copy it holds.
 */
export function generateEventCancel(
  event: IcsInviteEvent,
  options: GenerateEventInviteOptions,
): string {
  return serializeIcsEvent(event, 'CANCEL', options);
}
