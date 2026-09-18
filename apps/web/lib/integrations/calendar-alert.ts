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
import { dayKeyOf, formatDayHeading } from '~/lib/format/datetime';

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

/** At most this many ALERTABLE changes per connection per sweep, soonest first. A
 * household that rebuilds its September in one sitting produces thirty edits in one
 * 15-minute window; the ones worth a text are the ones happening next. Counted over the
 * changes that survive the window, never over the raw page — see
 * {@link alertParentForCalendarChanges}. */
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
 * One sweep's worth of calendar changes for one connection → one outcome per change, in
 * the order the changes arrived.
 *
 * ELIGIBILITY BEFORE THE CAP, which is the whole of this function's shape. A change Hale
 * would never text about is not a slot: renaming a weekly class returns every instance of
 * the series with a fresh `updated` stamp, the finished ones included, and capping before
 * the window is judged lets five Tuesdays that already happened swallow the sweep while
 * tomorrow's class goes unsaid — permanently, because syncCalendar advanced the syncToken
 * the moment it read the page. So: decide the window for ALL of them, sort what survives
 * soonest-first, and spend the five on those.
 */
export async function alertParentForCalendarChanges(
  database: Database,
  input: CalendarAlertInput,
  ports: CalendarAlertPorts,
): Promise<readonly CalendarAlertOutcome[]> {
  const { familyId, parentUserId, changes, now } = input;
  if (parentUserId === null) return changes.map(() => 'no_parent_user');
  if (input.seeding) return changes.map(() => 'seeding_run');
  // Before the clock read below: the flag is a pure function of the family id, so a query
  // in front of it is a query per sweep for a family Hale may not speak to at all.
  if (!f14EnabledFor(familyId)) return changes.map(() => 'dark');

  const timeZone = await ports.timeZone(parentUserId);
  const outcomes = new Array<CalendarAlertOutcome>(changes.length);
  const eligible: Array<{ at: number; change: CalendarChange; span: EventSpan }> = [];
  changes.forEach((change, at) => {
    const span = eventSpan(change, timeZone);
    if (span === null) outcomes[at] = 'no_start';
    else if (!withinAlertWindow(change, span, now)) outcomes[at] = 'outside_window';
    else eligible.push({ at, change, span });
  });

  eligible.sort((a, b) => a.span.startMs - b.span.startMs);
  for (const [rank, { at, change, span }] of eligible.entries()) {
    outcomes[at] =
      rank < CALENDAR_ALERT_MAX_PER_SWEEP
        ? await alertOne(database, input, parentUserId, change, span, timeZone, ports)
        : 'over_sweep_cap';
  }
  return outcomes;
}

async function alertOne(
  database: Database,
  input: CalendarAlertInput,
  parentUserId: string,
  change: CalendarChange,
  span: EventSpan,
  timeZone: string,
  ports: CalendarAlertPorts,
): Promise<CalendarAlertOutcome> {
  const { familyId, integrationId, now } = input;
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
export function eventSpan(change: CalendarChange, timeZone: string): EventSpan | null {
  const allDay = change.start.date !== undefined;
  const startMs = instantOf(change.start, timeZone);
  if (startMs === null) return null;
  const endMs = instantOf(change.end, timeZone);
  return {
    startMs,
    endMs: endMs === null || endMs <= startMs ? startMs + (allDay ? 86_400_000 : 0) : endMs,
    allDay,
  };
}

function instantOf(point: { dateTime?: string; date?: string }, timeZone: string): number | null {
  if (point.dateTime !== undefined) {
    const ms = Date.parse(point.dateTime);
    return Number.isNaN(ms) ? null : ms;
  }
  return point.date === undefined ? null : dayStartInZone(point.date, timeZone);
}

/**
 * The instant a bare calendar DAY begins in the parent's zone.
 *
 * A Google all-day event carries `date: '2026-09-17'`, which is not an instant: it is the
 * day the parent typed. The web surfaces anchor such a value at UTC midnight so the day
 * round-trips on screen (`formatCalendarDate`), but both questions this module asks are
 * about the parent's wall clock, and UTC answers them a few hours early: at 9 p.m. in
 * Toronto, today's PA day is already yesterday in UTC and would be judged over.
 *
 * Resolved twice because the offset depends on the instant being resolved — the first
 * pass lands within an hour, the second is exact across a DST change.
 */
function dayStartInZone(day: string, timeZone: string): number | null {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) return null;
  const approx = utcMidnight - zoneOffsetMs(utcMidnight, timeZone);
  return utcMidnight - zoneOffsetMs(approx, timeZone);
}

/** How far `timeZone`'s wall clock runs from UTC at this instant. `hourCycle: 'h23'`
 * rather than `hour12: false`, which renders local midnight as hour 24 of the PREVIOUS
 * day under some ICU builds — a whole day of error at exactly the boundary this is for. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const wall = Date.parse(
    `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}Z`,
  );
  return wall - instant;
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
  // One zone for everything, because an all-day span is already anchored at midnight in
  // it ({@link dayStartInZone}) — the day the parent typed IS the day this names.
  const day = asciiSpaces(formatDayHeading(new Date(span.startMs), timeZone, now));

  if (change.status === 'cancelled') {
    return endSentence(`${title} on ${day} was cancelled`);
  }

  const when = span.allDay
    ? dayRange(span, day, timeZone, now)
    : `${day}, ${clockRange(span, timeZone, now)}`;
  return endSentence(`${title} is on your calendar for ${when}${placePhrase(change)}`);
}

/**
 * `Monday, Sep 21`, or `Monday, Sep 21 to Friday, Sep 25` for a camp that runs a week.
 *
 * Google's all-day `end.date` is EXCLUSIVE, so the last day the parent is actually out is
 * the one the final millisecond falls in. A millisecond rather than a day of arithmetic:
 * subtracting 24h lands an hour off across a DST change and can name the wrong day.
 */
function dayRange(span: EventSpan, startDay: string, timeZone: string, now: Date): string {
  const lastDay = asciiSpaces(formatDayHeading(new Date(span.endMs - 1), timeZone, now));
  return lastDay === startDay ? startDay : `${startDay} to ${lastDay}`;
}

/**
 * `4:15-5:00 p.m.`, `11:30 a.m.-1:00 p.m.`, or — once the event crosses midnight — the
 * second day spelled out, because "10:00 p.m.-7:00 a.m." on its own reads as a typo.
 *
 * An event ending AT midnight is not one of those: it belongs to the day it started, and
 * "10:00 p.m. to Saturday, Sep 19, 12:00 a.m." names a day the parent is not out for.
 *
 * The start's `a.m.`/`p.m.` is dropped when it matches the end's: two of them in seven
 * characters of clock is how a machine writes a time, not how a parent reads one.
 */
function clockRange(span: EventSpan, timeZone: string, now: Date): string {
  const start = clockParts(span.startMs, timeZone);
  const end = clockParts(span.endMs, timeZone);
  const endDay = asciiSpaces(formatDayHeading(new Date(span.endMs), timeZone, now));
  const startDay = asciiSpaces(formatDayHeading(new Date(span.startMs), timeZone, now));
  if (endDay !== startDay && !endsAtDayStart(span, timeZone)) {
    return `${start.clock} ${start.dayPeriod} to ${endDay}, ${end.clock} ${end.dayPeriod}`;
  }
  const head =
    start.dayPeriod === end.dayPeriod ? start.clock : `${start.clock} ${start.dayPeriod}`;
  return `${head}-${end.clock} ${end.dayPeriod}`;
}

/** Whether the event ends on the stroke of a local day — the one way an end can fall on
 * the next date without the event running into it. */
function endsAtDayStart(span: EventSpan, timeZone: string): boolean {
  return dayStartInZone(dayKeyOf(new Date(span.endMs), timeZone), timeZone) === span.endMs;
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
