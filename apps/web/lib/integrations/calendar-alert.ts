import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import { asciiCopy, asciiSpaces } from '~/lib/channel/intake/radar-decide';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import type {
  ProactiveHoldReason,
  ProactiveSendRequest,
  ProactiveSendVerdict,
} from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { formatDayHeading } from '~/lib/format/datetime';

/**
 * A change on a connected Google Calendar becomes ONE text to the parent.
 *
 * The sibling of lib/integrations/email-alert.ts, and the differences are the whole of
 * the design. The inbox needs a classifier because most of what arrives in it is not
 * about this family; a calendar does not, because the parent PUT the event there. So
 * there is no model call on this path at all — the only judgement left is about TIME
 * (is this soon enough to be worth interrupting for?) and the sentence is assembled from
 * Google's own fields.
 *
 * WHAT IT MAY NOT DO:
 *   - The description and the attendees never leave this module. A calendar description
 *     is where a parent keeps the doctor's reason and the other family's address, and an
 *     attendee list is other people's email addresses (rule #1). The text carries the
 *     summary, the time, and a short clean location.
 *   - A SEEDING run alerts nobody. The first sync of a connection sees the whole
 *     calendar; so does the full resync Google forces after a stale syncToken. Either
 *     one would be two hundred texts about events the parent already knows about.
 *   - Every ending is a named outcome ({@link CalendarAlertOutcome}) the cron summary
 *     counts (rule #11). `alert_failed` is the one this module cannot return for itself:
 *     the sweep holds a boundary around the call and names it, so a bug in Hale's alert
 *     path never arrives as a broken CALENDAR connection that stops the ingest too.
 */

/**
 * One raw change from an INCREMENTAL events.list page, before anything decides whether it
 * deserves a text. Cancelled items are here and deliberately not in the ingest events —
 * Hale holds no event store to delete from, but a cancellation is the single most useful
 * thing this feature says.
 */
export interface CalendarChange {
  eventId: string;
  /** Google's own last-modification stamp. It is half the dedupe key, which is what makes
   * a MOVED event a new text and a re-read of the same page free. */
  updated: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** `summary`, which Google permits to be absent — rendered as 'Untitled' rather than
   * as a sentence with a hole in it. */
  title?: string;
  /** `dateTime` for a timed event, `date` for an all-day one; a tombstone can carry
   * neither, which is {@link CALENDAR_ALERT_OUTCOMES}'s `no_start`. */
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  /** `organizer.self` — this family's own event rather than one they were invited to.
   * Carried because it is a fact about the change worth having in one place; nothing
   * branches on it today. */
  selfOrganized?: boolean;
}

/**
 * Every way one change can end, flat so the cron summary can count it by name.
 *
 * `outside_window` and `no_start` are two facts, not one. "This is in forty days" is a
 * quiet week; "Google sent a tombstone with no date on it" is a sweep that cannot see —
 * and folding the second into the first is how a connector goes blind without anyone
 * being able to tell (rule #11).
 */
export const CALENDAR_ALERT_OUTCOMES = [
  'sent',
  'already_sent',
  'dark',
  'seeding_run',
  'over_sweep_cap',
  'outside_window',
  'no_start',
  'no_parent_user',
  'gate_refused:not_enrolled',
  'gate_refused:no_watch_consent',
  'gate_refused:frequency_cap',
  'gate_refused:quiet_hours',
  'no_send_target',
  'send_failed',
  'alert_failed',
] as const;

export type CalendarAlertOutcome = (typeof CALENDAR_ALERT_OUTCOMES)[number];

export type CalendarAlertCounts = Record<CalendarAlertOutcome, number>;

export function emptyCalendarAlertCounts(): CalendarAlertCounts {
  return Object.fromEntries(CALENDAR_ALERT_OUTCOMES.map((o) => [o, 0])) as CalendarAlertCounts;
}

/** At most this many changes per connection per sweep, SOONEST FIRST. A household that
 * rebuilds its September in one sitting produces thirty edits in one 15-minute window;
 * the ones worth a text are the ones happening next. */
export const CALENDAR_ALERT_MAX_PER_SWEEP = 5;

/** How far ahead an event has to start to be worth interrupting for. A cancellation is
 * exempt from the ceiling (see {@link withinAlertWindow}) — a March camp that just went
 * away is news in September. */
export const CALENDAR_ALERT_WINDOW_DAYS = 14;

export const CALENDAR_ALERT_TEMPLATE_KEY = 'connector:calendar_alert';

const HOLD_STATUS: Record<
  ProactiveHoldReason,
  'suppressed_quiet_hours' | 'suppressed_cap' | 'suppressed_consent'
> = {
  quiet_hours: 'suppressed_quiet_hours',
  frequency_cap: 'suppressed_cap',
  not_enrolled: 'suppressed_consent',
  no_watch_consent: 'suppressed_consent',
};

/**
 * Keyed on the CONNECTION, the event and Google's `updated` stamp.
 *
 * The third component is what makes this feature honest about edits: a no-op re-sync
 * replays the same stamp and costs nothing, while a moved event carries a new one and
 * earns a second text. Keyed on the event alone, Hale would announce a class once and
 * never mention that it moved.
 */
export function calendarAlertDedupeKey(
  integrationId: string,
  eventId: string,
  updated: string,
): string {
  return `calendar_alert:${integrationId}:${eventId}:${updated}`;
}

export interface CalendarAlertPorts {
  gate(request: ProactiveSendRequest): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
  /** The parent's wall clock — the zone every time in the message is rendered in. */
  timeZone(parentUserId: string): Promise<string>;
}

export interface CalendarAlertInput {
  familyId: string;
  /** `integrations.user_id`, which the column permits to be null. A calendar with no
   * connecting user has nobody to text, and that is an outcome, not a skip. */
  parentUserId: string | null;
  integrationId: string;
  /** This run had no syncToken to start from (a first sync, or the full resync Google
   * forces after a stale one), so its changes are the calendar's whole history. */
  seeding: boolean;
  changes: readonly CalendarChange[];
  now: Date;
}

/**
 * One sweep's worth of calendar changes for one connection → one outcome per change.
 *
 * Soonest first and bounded: the interesting failure is not a quiet calendar, it is a
 * parent rebuilding their term on a Sunday evening.
 */
export async function alertParentForCalendarChanges(
  database: Database,
  input: CalendarAlertInput,
  ports: CalendarAlertPorts,
): Promise<readonly CalendarAlertOutcome[]> {
  const { parentUserId, changes } = input;
  if (parentUserId === null) return changes.map(() => 'no_parent_user');
  if (input.seeding) return changes.map(() => 'seeding_run');

  const ordered = [...changes].sort((a, b) => startOrder(a) - startOrder(b));
  const outcomes: CalendarAlertOutcome[] = [];
  for (let i = CALENDAR_ALERT_MAX_PER_SWEEP; i < ordered.length; i += 1) {
    outcomes.push('over_sweep_cap');
  }

  const considered = ordered.slice(0, CALENDAR_ALERT_MAX_PER_SWEEP);
  if (considered.length === 0) return outcomes;

  const timeZone = await ports.timeZone(parentUserId);
  for (const change of considered) {
    outcomes.push(await alertOne(database, input, parentUserId, change, timeZone, ports));
  }
  return outcomes;
}

async function alertOne(
  database: Database,
  input: CalendarAlertInput,
  parentUserId: string,
  change: CalendarChange,
  timeZone: string,
  ports: CalendarAlertPorts,
): Promise<CalendarAlertOutcome> {
  const { familyId, integrationId, now } = input;
  if (!f14EnabledFor(familyId)) return 'dark';

  const span = eventSpan(change);
  if (span === null) return 'no_start';
  if (!withinAlertWindow(change, span, now)) return 'outside_window';

  const dedupeKey = calendarAlertDedupeKey(integrationId, change.eventId, change.updated);
  if (await dedupeActive(dedupeKey, database)) return 'already_sent';

  const verdict = await ports.gate({ familyId, parentUserId, kind: 'calendar_alert', now });
  if (!verdict.allowed) {
    // A RECEIPT, not a claim. The syncToken advanced past this change the moment the
    // sweep read it, so nothing will offer it again — this row is the whole lasting
    // record that Hale saw a cancellation at 23:40 and chose to stay quiet.
    //
    // The key stays NULL: the unique index is total over non-null dedupe keys, so a
    // suppression carrying it would block the send it is a record of NOT making.
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'calendar_alert',
      templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
      dedupeKey: null,
      status: HOLD_STATUS[verdict.reason],
    });
    console.warn({ familyId, reason: verdict.reason }, 'calendar alert: held by the outbound gate');
    return `gate_refused:${verdict.reason}`;
  }

  const message = renderCalendarAlert(change, span, timeZone, now);

  // CLAIM FIRST, by the insert rather than by a read a concurrent sweep can race.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'calendar_alert',
      templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
      dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';

  const to = await ports.resolvePhone(database, parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so this is a contradiction
    // between two readers of the same table. Recorded on the claimed row rather than
    // thrown: leaving it queued forever would read as a text in flight.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_send_target' })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error(
      { familyId, parentUserId },
      'calendar alert: the gate allowed a parent with no sendable number',
    );
    return 'no_send_target';
  }

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await ports.transport.send({
      to,
      body: withOptOut(message, verdict.optOut),
    }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.error({ familyId, code }, 'calendar alert: the provider refused the text');
    return 'send_failed';
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));

  // The composed sentence, not the wire body — the CASL line belongs on the wire, and
  // the coach re-reads this row next turn (channel/thread.ts).
  await ports.threadMessage(database, { familyId, parentUserId, body: message });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'calendar_alert_sent',
    targetTable: 'channel_messages',
    targetId: claimed.id,
    // Enums and flags only. Not the title, not the location: an audit row a support
    // agent can read is a copy of the calendar in a table that is never redacted.
    after: { status: change.status, allDay: span.allDay },
  });

  return 'sent';
}

// ── When it is ───────────────────────────────────────────────────────────────

export interface EventSpan {
  startMs: number;
  /** When the event is over. An all-day `end.date` is EXCLUSIVE in Google's model, and a
   * one-day event that omits it ends 24h after its start. */
  endMs: number;
  allDay: boolean;
}

/** The instants this change is about, or null when Google sent neither a `dateTime` nor
 * a `date` — the shape of a deleted single event on an incremental page. Resolved ONCE
 * per change and handed to the renderer, so the window decision and the sentence can
 * never disagree about which day this is. */
export function eventSpan(change: CalendarChange): EventSpan | null {
  const allDay = change.start.date !== undefined;
  const startMs = instantOf(change.start);
  if (startMs === null) return null;
  const endMs = instantOf(change.end);
  return {
    startMs,
    endMs: endMs === null || endMs <= startMs ? startMs + (allDay ? 86_400_000 : 0) : endMs,
    allDay,
  };
}

/** A bare `date` is read as UTC midnight so the calendar day the parent typed round-trips
 * exactly, the same discipline `formatCalendarDate` keeps. */
function instantOf(point: { dateTime?: string; date?: string }): number | null {
  const raw = point.dateTime ?? (point.date === undefined ? undefined : `${point.date}T00:00:00Z`);
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Sort key for the per-sweep cap. A change Hale cannot place in time sorts last, so it
 * never displaces a real event from the five. */
function startOrder(change: CalendarChange): number {
  return eventSpan(change)?.startMs ?? Number.POSITIVE_INFINITY;
}

/**
 * Whether this change is soon enough to interrupt for.
 *
 * An event already over is never worth a text. Beyond that the two directions differ: a
 * NEW or MOVED event is only interesting inside the fortnight a parent plans against,
 * while a CANCELLATION is interesting however far out it is — the thing the parent has
 * to know is that it is not happening, and that does not get less true in March.
 */
function withinAlertWindow(change: CalendarChange, span: EventSpan, now: Date): boolean {
  if (span.endMs <= now.getTime()) return false;
  if (change.status === 'cancelled') return true;
  return span.startMs <= now.getTime() + CALENDAR_ALERT_WINDOW_DAYS * 86_400_000;
}

// ── The sentence ─────────────────────────────────────────────────────────────

/** The two clamps that keep the body inside TWO GSM-7 segments once the full opt-out
 * paragraph is appended. Nothing else in the message is variable-length, so these are
 * what make that arithmetic a fact rather than a hope; the property test in this
 * module's suite is the proof. */
const TITLE_MAX = 60;
const LOCATION_MAX = 40;
const UNTITLED = 'Untitled';

/**
 * The text, assembled from Google's fields and nothing else.
 *
 * Deterministic on purpose (rule #2): there is no prompt here and no model call. The
 * calendar already says what is happening; a composer would only give it a chance to say
 * something the calendar did not.
 */
export function renderCalendarAlert(
  change: CalendarChange,
  span: EventSpan,
  timeZone: string,
  now: Date,
): string {
  const title = clampTitle(gsm7(change.title ?? '')) || UNTITLED;
  // A bare `date` is a calendar DAY, not an instant: rendering it in a zone west of UTC
  // would name the day before the one the parent typed.
  const dayZone = span.allDay ? 'UTC' : timeZone;
  const day = asciiSpaces(formatDayHeading(new Date(span.startMs), dayZone, now));

  if (change.status === 'cancelled') {
    return endSentence(`${title} on ${day} was cancelled`);
  }

  const when = span.allDay ? day : `${day}, ${clockRange(span, timeZone, now)}`;
  return endSentence(`${title} is on your calendar for ${when}${placePhrase(change)}`);
}

/**
 * `4:15-5:00 p.m.`, `11:30 a.m.-1:00 p.m.`, or — once the event crosses midnight — the
 * second day spelled out, because "10:00 p.m.-7:00 a.m." on its own reads as a typo.
 *
 * The start's `a.m.`/`p.m.` is dropped when it matches the end's: two of them in seven
 * characters of clock is how a machine writes a time, not how a parent reads one.
 */
function clockRange(span: EventSpan, timeZone: string, now: Date): string {
  const start = clockParts(span.startMs, timeZone);
  const end = clockParts(span.endMs, timeZone);
  const endDay = asciiSpaces(formatDayHeading(new Date(span.endMs), timeZone, now));
  const startDay = asciiSpaces(formatDayHeading(new Date(span.startMs), timeZone, now));
  if (endDay !== startDay) {
    return `${start.clock} ${start.dayPeriod} to ${endDay}, ${end.clock} ${end.dayPeriod}`;
  }
  const head =
    start.dayPeriod === end.dayPeriod ? start.clock : `${start.clock} ${start.dayPeriod}`;
  return `${head}-${end.clock} ${end.dayPeriod}`;
}

function clockParts(ms: number, timeZone: string): { clock: string; dayPeriod: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    clock: asciiSpaces(`${pick('hour')}:${pick('minute')}`),
    dayPeriod: asciiSpaces(pick('dayPeriod')),
  };
}

/**
 * ` at Stouffville Leisure Centre`, or nothing.
 *
 * A calendar `location` is a free-text field, and the two things parents actually put in
 * it that must never be read aloud are a joining link with an address in it and a pasted
 * block of directions. Any '@' drops the whole phrase rather than being scrubbed out of
 * it — a mailbox in a text is a mailbox anyone holding the phone can write to — and a
 * long one is dropped rather than truncated, because half a street address helps nobody.
 */
function placePhrase(change: CalendarChange): string {
  if (change.location === undefined) return '';
  const place = gsm7(change.location);
  if (place === '' || place.length > LOCATION_MAX || place.includes('@')) return '';
  return ` at ${place}`;
}

/** `7 a.m.` and `Sep 17` both already end a sentence; a second full stop reads as a typo. */
function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * Text the PARENT wrote, made safe to put on a wire Hale is billed for: folded where
 * there is an obvious ASCII equivalent ({@link asciiCopy}), dropped where there is not,
 * whitespace collapsed so a pasted title cannot open a second line under Hale's name.
 *
 * The strict printable-basic test, not `isGsm7`: the basic alphabet contains LF and CR
 * and the extension table costs two septets, so neither belongs in a string whose length
 * is being budgeted one septet per character.
 */
function gsm7(text: string): string {
  let out = '';
  for (const char of asciiCopy(text)) {
    if (isPrintableGsm7Basic(char)) out += char;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Cut to the budget with an explicit ellipsis, so a parent can see that the calendar
 * said more than the text does. */
function clampTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX - 3).trimEnd()}...`;
}
