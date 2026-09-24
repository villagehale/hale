import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { asciiCopy, asciiSpaces } from '~/lib/channel/intake/radar-decide';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveSendRequest,
  type ProactiveSendVerdict,
  holdStatus,
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
 * THE SWEEP HAS A MEMORY (calendar_event_snapshots), which is the whole of the second
 * pass on this module. events.list is a delta reader: it hands a change over once and the
 * syncToken advances past it the same instant, so anything that could not be answered
 * from one change in isolation could not be answered at all. Three follow-ups off #650
 * were all that one gap:
 *   - a moved event read "is on your calendar for <new time>" — nothing held the OLD time;
 *   - one edit to a weekly class arrived as one change per instance and spent the whole
 *     per-sweep budget on itself — nothing grouped them;
 *   - a change refused by quiet hours was never offered again — nothing remembered that
 *     Hale still owed the text.
 *
 * WHAT IT MAY NOT DO:
 *   - The description and the attendees never leave this module. A calendar description
 *     is where a parent keeps the doctor's reason and the other family's address, and an
 *     attendee list is other people's email addresses (rule #1). The text carries the
 *     summary, the time, and a short clean location.
 *   - The memory holds the SHAPE of an event (when, all-day, which series) always, and
 *     the parent's own words — the clamped title, the vetted location — only while a text
 *     is owed and not one sweep longer. A table CHECK enforces that, not a habit.
 *   - A SEEDING run alerts nobody, and remembers everybody. The first sync of a
 *     connection sees the whole calendar; so does the full resync Google forces after a
 *     stale syncToken. Either one would be two hundred texts about events the parent
 *     already knows about — but it is also the ONLY sighting Hale ever gets of an event
 *     that pre-dates the connection, so a run that wrote nothing would make the first
 *     edit to any of them read as a first sighting. Shape only, no words, and a text
 *     already owed is left exactly as it was.
 *   - A family dark behind F14 is swept the same way, and for the same reason: no text,
 *     no receipt, nothing of the parent's kept — but the shape is written down, because
 *     the syncToken advances whether Hale may speak or not and a month of dark that wrote
 *     nothing would make the first change after the flip a first sighting too. A hold
 *     outstanding when the flag goes off is not sent late and not cancelled either; it
 *     ages out at {@link CALENDAR_ALERT_PENDING_MAX_DAYS} like any other. A connection
 *     with no connecting user has nobody to text and nobody's clock to read, so it is not
 *     swept at all.
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
  /** Google's `recurringEventId`: the SERIES this item is an instance of, absent on a
   * one-off. The request sets `singleEvents=true`, so one edit to a weekly class comes
   * back as one change per instance — this is the only field that says so, and grouping
   * on it (with {@link seriesNews}, because a session called off is not the same news as
   * the term it was part of) is what turns six changes into one text. */
  recurringEventId?: string;
  /** The version of this event, and half the dedupe key — which is what makes a MOVED
   * event a new text and a re-read of the same page free. Google's `updated` where there
   * is one; the sync falls back to the etag and then to its own clock, because the items
   * carrying least are the cancellations (see `calendarChangeOf`). */
  updated: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** `summary`, which Google permits to be absent — rendered generically rather than as a
   * sentence with a hole in it, and a tombstone never carries one at all. */
  title?: string;
  /** `dateTime` for a timed event, `date` for an all-day one, and a cancelled recurring
   * instance's `originalStartTime` where Google sent no `start`. A deleted SINGLE event
   * carries none of the three, which is {@link CALENDAR_ALERT_OUTCOMES}'s `no_start`. */
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
 * being able to tell (rule #11). The three added with the memory keep that discipline:
 * `collapsed_into_series` is an instance a text DID go out about, `pending_expired` is a
 * text Hale gave up owing, and `pending_outside_window` is one the calendar overtook.
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
  /** This instance was spoken for by the ONE text its series got. Not `already_sent`,
   * which means a previous sweep covered it: a sweep where a class moved reads as five of
   * these and one `sent`, and that is the shape the collapse is working. */
  'collapsed_into_series',
  /** A held change Hale stopped owing: the re-offer never got past the gate inside
   * {@link CALENDAR_ALERT_PENDING_MAX_DAYS}, and a three-day-old "it moved" is noise. */
  'pending_expired',
  /** A held change the calendar overtook — the event happened, or its cancellation is now
   * in the past — so there is nothing left to say. Distinct from `outside_window`, which
   * is about a change that arrived this sweep. */
  'pending_outside_window',
  /** The family has a claimed Linq group. Kid dates are spoken there by the
   * household notice. This SMS path stays quiet so a non-kid title never
   * reaches the group and nothing is retried on Twilio. */
  'group_home',
] as const;

export type CalendarAlertOutcome = (typeof CALENDAR_ALERT_OUTCOMES)[number];

export type CalendarAlertCounts = Record<CalendarAlertOutcome, number>;

export function emptyCalendarAlertCounts(): CalendarAlertCounts {
  return Object.fromEntries(CALENDAR_ALERT_OUTCOMES.map((o) => [o, 0])) as CalendarAlertCounts;
}

/**
 * One sweep's answer, in two lists rather than one.
 *
 * `changes` is positional — one outcome per change, in the order they arrived — because
 * that is the only way a caller can tell WHICH change was dropped. The re-offers are not
 * in that input at all, so appending them to it would make position meaningless and hide
 * them in a bucket that means something else (rule #11). The summary counts both.
 */
export interface CalendarAlertSweep {
  changes: readonly CalendarAlertOutcome[];
  /** One per pending snapshot this sweep picked back up, oldest debt first. */
  reoffers: readonly CalendarAlertOutcome[];
}

/** At most this many ALERTABLE texts per connection per sweep, oldest debt first and then
 * soonest first. A household that rebuilds its September in one sitting produces thirty
 * edits in one 15-minute window; the ones worth a text are the ones happening next. A
 * series collapsed into one text spends ONE of these, and a re-offer spends one too —
 * which is what keeps the budget a budget rather than two of them. */
export const CALENDAR_ALERT_MAX_PER_SWEEP = 5;

/** How far ahead an event has to start to be worth interrupting for. A cancellation is
 * exempt from the ceiling (see {@link withinAlertWindow}) — a March camp that just went
 * away is news in September. */
export const CALENDAR_ALERT_WINDOW_DAYS = 14;

/** How long Hale keeps owing a text the gate refused. Past this the news is stale — a
 * three-day-old "it moved to Thursday" is worse than silence — and the hold is dropped
 * with its own name rather than lingering as a queue nobody drains. */
export const CALENDAR_ALERT_PENDING_MAX_DAYS = 3;

/** A group of this many instances of one series, in one sweep, is one text: two changes
 * about the same class are the same news said twice, and they spend one of the five slots
 * rather than two. Below it — a lone instance, which is what a single cancelled session
 * inside a live term reduces to — the change is an ordinary single. */
const SERIES_MIN_INSTANCES = 2;

export const CALENDAR_ALERT_TEMPLATE_KEY = 'connector:calendar_alert';

/**
 * The endings that mean "not yet", as opposed to "no".
 *
 * These three are the whole of the pending mechanism: the text was worth sending, Hale
 * declined to send it THIS minute, and the syncToken has already moved past the change —
 * so unless the sweep writes down that it still owes one, the news is gone for good. A
 * consent refusal is deliberately not here: `not_enrolled` is not a wait, it is an answer.
 */
const HELD_OUTCOMES = new Set<CalendarAlertOutcome>([
  'gate_refused:quiet_hours',
  'gate_refused:frequency_cap',
  'over_sweep_cap',
]);

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

/**
 * The same key for a SERIES, so one edit to a weekly class is one text however many
 * instances carried it.
 *
 * The stamp is the LATEST of the group's, which is what makes a re-offer of a held series
 * claim the key the original hold would have claimed: both groups carry the same set of
 * `updated` values, so both reduce to the same string.
 *
 * The KIND is in the key for the same reason it is in the grouping ({@link seriesNews}):
 * the live half and the cancelled half of one series are two different texts, and one key
 * over both would let whichever went second read as a duplicate of the first.
 */
export function calendarSeriesAlertDedupeKey(
  integrationId: string,
  recurringEventId: string,
  news: SeriesNews,
  updated: string,
): string {
  return `calendar_alert:${integrationId}:series:${news}:${recurringEventId}:${updated}`;
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

/** One change placed in time, with everything the sweep knows about it: where its outcome
 * goes, what Hale last said about it, and how long it has been owed. */
interface Placed {
  change: CalendarChange;
  span: EventSpan;
  /** The start the parent was last told, when it differs from this one. Null on a first
   * sighting and on a cancellation, both of which read as today's sentence. */
  previous: PriorStart | null;
  /** When Hale started owing this text, or null for a change that arrived this sweep. */
  pendingSince: Date | null;
  write(outcome: CalendarAlertOutcome): void;
}

/** One text, and the one to five instances it speaks for. The first member is the one it
 * is derived from and the one that receives the real outcome. */
interface Offer {
  group: readonly Placed[];
  dedupeKey: string;
  pendingSince: Date | null;
  startMs: number;
  render(): string;
  /** What the memory has to keep if this one is held — the whole of the re-offer. */
  heldTitle: string;
  heldLocation: string | null;
}

/**
 * One sweep's worth of calendar changes for one connection → one outcome per change, plus
 * one per pending text this sweep picked back up.
 *
 * WHAT HALE ALREADY OWED COMES FIRST, then eligibility, then the cap — and that order is
 * the whole of this function's shape.
 *
 * Eligibility before the cap, because a change Hale would never text about is not a slot:
 * renaming a weekly class returns every instance of the series with a fresh `updated`
 * stamp, the finished ones included, and capping before the window is judged lets five
 * Tuesdays that already happened swallow the sweep while tomorrow's class goes unsaid.
 *
 * Debts before new news, because a debt is already late. A text quiet hours refused at
 * 11:40 p.m. is offered again at 8 a.m., and it would never survive a queue that always
 * put this minute's edits in front of it.
 */
export async function alertParentForCalendarChanges(
  database: Database,
  input: CalendarAlertInput,
  ports: CalendarAlertPorts,
): Promise<CalendarAlertSweep> {
  const { familyId, parentUserId, integrationId, changes, now } = input;
  if (parentUserId === null) return { changes: changes.map(() => 'no_parent_user'), reoffers: [] };
  if (input.seeding) {
    await rememberOnly(database, input, parentUserId, ports);
    return { changes: changes.map(() => 'seeding_run'), reoffers: [] };
  }
  // The flag is a pure function of the family id, so nothing above it costs a query and a
  // dark sweep of an empty page is the cheapest thing this module does. A dark sweep with
  // changes in it still REMEMBERS them: the syncToken advances whether Hale may speak or
  // not, so a dark period that wrote nothing would leave the memory holding a calendar
  // weeks out of date, and the first change after the flip would read as a first sighting
  // or name a "was" nobody was ever told.
  if (!f14EnabledFor(familyId)) {
    await rememberOnly(database, input, parentUserId, ports);
    return { changes: changes.map(() => 'dark'), reoffers: [] };
  }
  // The group is the home channel. Kid dates are spoken by the household
  // notice. The SMS sentence names whatever title Google stored, including
  // events that are not the kids', so it does not move to the group and it
  // does not stay on Twilio.
  const outbound = await familyOutboundTarget(database, familyId);
  if (outbound.channel === 'group') {
    await rememberOnly(database, input, parentUserId, ports);
    console.info(
      { familyId },
      'calendar alert: group is the home channel — SMS path quiet, kid dates use the group notice',
    );
    return { changes: changes.map(() => 'group_home'), reoffers: [] };
  }

  // ONE read for both halves of the memory: what Hale last said about the events in this
  // page, and every text it still owes on this connection. A quiet calendar with no debts
  // costs this one indexed query and nothing else — not even the clock read.
  const memory = await readSnapshots(database, integrationId, changes);
  const arrived = new Set(changes.map((change) => change.eventId));
  const debts = memory
    .filter((row): row is PendingSnapshot => isPending(row) && !arrived.has(row.eventId))
    .sort((a, b) => a.pendingSince.getTime() - b.pendingSince.getTime());
  if (changes.length === 0 && debts.length === 0) return { changes: [], reoffers: [] };

  const priorByEvent = new Map(memory.map((row) => [row.eventId, row]));
  const timeZone = await ports.timeZone(parentUserId);
  const changeOutcomes = new Array<CalendarAlertOutcome>(changes.length);
  const reofferOutcomes = new Array<CalendarAlertOutcome>(debts.length);
  const writes = new Map<string, SnapshotWrite>();

  const fresh: Placed[] = [];
  changes.forEach((change, at) => {
    const write = (outcome: CalendarAlertOutcome) => {
      changeOutcomes[at] = outcome;
    };
    const span = eventSpan(change, timeZone);
    // Nothing to remember about a shape nothing can place: a snapshot with no start
    // cannot make the next sighting a move, and cannot be re-offered either.
    if (span === null) {
      write('no_start');
      return;
    }
    const placed: Placed = {
      change,
      span,
      previous: movedFrom(priorByEvent.get(change.eventId), change, span),
      pendingSince: priorByEvent.get(change.eventId)?.pendingSince ?? null,
      write,
    };
    if (isOver(span, now)) {
      write('outside_window');
      // Remembered anyway, and deliberately: an event Hale stayed quiet about is still an
      // event whose time it now knows, so the edit that pulls it back into the fortnight
      // reads as the move it is.
      remember(writes, placed, null);
      return;
    }
    fresh.push(placed);
  });

  const owed: Placed[] = [];
  debts.forEach((row, at) => {
    const write = (outcome: CalendarAlertOutcome) => {
      reofferOutcomes[at] = outcome;
    };
    const placed = revive(row, timeZone, write);
    const ageMs = now.getTime() - row.pendingSince.getTime();
    if (ageMs > CALENDAR_ALERT_PENDING_MAX_DAYS * 86_400_000) {
      write('pending_expired');
      remember(writes, placed, null);
      return;
    }
    if (isOver(placed.span, now)) {
      write('pending_outside_window');
      remember(writes, placed, null);
      return;
    }
    owed.push(placed);
  });

  const offers = [
    ...offersOf(owed, integrationId, timeZone, now, writes, 'pending_outside_window').sort(
      (a, b) => (a.pendingSince?.getTime() ?? 0) - (b.pendingSince?.getTime() ?? 0),
    ),
    ...offersOf(fresh, integrationId, timeZone, now, writes, 'outside_window').sort(
      (a, b) => a.startMs - b.startMs,
    ),
  ];
  for (const [rank, offer] of offers.entries()) {
    const outcome =
      rank < CALENDAR_ALERT_MAX_PER_SWEEP
        ? await sendOffer(database, input, parentUserId, offer, ports)
        : 'over_sweep_cap';
    settle(offer, outcome, writes, now);
  }

  await writeSnapshots(database, integrationId, writes, now);
  return { changes: changeOutcomes, reoffers: reofferOutcomes };
}

/**
 * The whole job of a sweep that may alert nobody: write down the SHAPE of a calendar no
 * text is going out about.
 *
 * Two sweeps end here. The first sync of a connection — and the full resync Google forces
 * after a stale syncToken — is the only sighting the memory ever gets of everything that
 * pre-dates it. A sweep for a family still dark behind F14 is the same shape for a
 * different reason: the syncToken advances past those changes regardless, so a dark month
 * that wrote nothing leaves the memory a month stale. Either way, skipping the write costs
 * nothing anyone can see on the day and makes the next edit read as a first sighting —
 * which is the follow-up this module exists to close.
 *
 * A text already owed is left exactly as it was, row and words and instant. A resync is
 * Google losing its place and a dark flag is Hale being told not to speak; neither is Hale
 * giving up on a text it promised — and dropping the debt inside either would end it under
 * an outcome that says "alerted nobody" (rule #11). A hold outstanding when the flag goes
 * off ages out at {@link CALENDAR_ALERT_PENDING_MAX_DAYS} like any other.
 */
async function rememberOnly(
  database: Database,
  input: CalendarAlertInput,
  parentUserId: string,
  ports: CalendarAlertPorts,
): Promise<void> {
  const { integrationId, changes, now } = input;
  if (changes.length === 0) return;
  const owed = new Set((await readSnapshots(database, integrationId, [])).map((row) => row.eventId));
  const timeZone = await ports.timeZone(parentUserId);
  const writes = new Map<string, SnapshotWrite>();
  for (const change of changes) {
    if (owed.has(change.eventId)) continue;
    const span = eventSpan(change, timeZone);
    // Nothing to remember about a shape nothing can place: it cannot make the next
    // sighting a move, and it cannot be re-offered either.
    if (span !== null) remember(writes, { change, span }, null);
  }
  await writeSnapshots(database, integrationId, writes, now);
}

async function sendOffer(
  database: Database,
  input: CalendarAlertInput,
  parentUserId: string,
  offer: Offer,
  ports: CalendarAlertPorts,
): Promise<CalendarAlertOutcome> {
  const { familyId, now } = input;
  const lead = offer.group[0];
  if (lead === undefined) throw new Error('sendOffer: an offer with no instances');
  if (await dedupeActive(offer.dedupeKey, database)) return 'already_sent';

  const verdict = await ports.gate({ familyId, parentUserId, kind: 'calendar_alert', now });
  if (!verdict.allowed) {
    // ONE receipt per piece of NEW news the gate refuses, written the moment it is
    // refused — and, for a hold that is a "not yet", half of a promise: the caller writes
    // the other half into the memory, so the syncToken moving past this change no longer
    // means nobody will ever offer it again.
    //
    // Not one per text OWED: a change the per-sweep cap held before the gate ever saw it
    // is already owed by the time it is offered, and its refusal writes no row at all. The
    // ledger is the surface a parent reads, and the sweep's own answer is where every
    // ending is named and counted (rule #11) — a receipt that says "we did not text you"
    // for a text the cap deferred is noise on the first surface and adds nothing to the
    // second.
    //
    // A re-offer the gate refuses again is the SAME suppressed text, and a row per attempt
    // would be forty-odd of them per held text per quiet-hours night on the surface a
    // parent reads. Logged instead, never silent (rule #11) — and the outcome is named in
    // the sweep's answer either way.
    //
    // The key stays NULL: the unique index is total over non-null dedupe keys, so a
    // suppression carrying it would block the send it is a record of NOT making.
    if (offer.pendingSince === null) {
      await database.insert(schema.channelMessages).values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'calendar_alert',
        templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
        dedupeKey: null,
        status: holdStatus(verdict.reason),
      });
    }
    console.warn(
      { familyId, reason: verdict.reason, owedSince: offer.pendingSince?.toISOString() ?? null },
      'calendar alert: held by the outbound gate',
    );
    return `gate_refused:${verdict.reason}`;
  }

  const message = offer.render();

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
      dedupeKey: offer.dedupeKey,
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
    // Enums, flags and counts only. Not the title, not the location: an audit row a
    // support agent can read is a copy of the calendar in a table that is never redacted.
    after: {
      status: lead.change.status,
      allDay: lead.span.allDay,
      instances: offer.group.length,
      moved: lead.previous !== null,
    },
  });

  return 'sent';
}

/**
 * The outcome reaches the instances it speaks for, and the memory reaches the next sweep.
 *
 * A held text keeps its ORIGINAL `pending_since` — the instant Hale first owed it, not
 * the instant it was refused again — because that is what makes the re-offer queue drain
 * in the order the news arrived instead of shuffling on every sweep.
 */
function settle(
  offer: Offer,
  outcome: CalendarAlertOutcome,
  writes: Map<string, SnapshotWrite>,
  now: Date,
): void {
  offer.group.forEach((member, index) => {
    member.write(index === 0 ? outcome : 'collapsed_into_series');
  });
  if (!HELD_OUTCOMES.has(outcome)) {
    for (const member of offer.group) remember(writes, member, null);
    return;
  }
  const since = offer.pendingSince ?? now;
  for (const member of offer.group) {
    remember(writes, member, {
      since,
      title: offer.heldTitle,
      location: offer.heldLocation,
      movedFrom: member.previous,
    });
  }
}

// ── One text per series ──────────────────────────────────────────────────────

/**
 * What a change about a series is NEWS of: the term as it now stands, or a session that
 * is off.
 *
 * The grouping key and the sentence both read this one function, which is what makes them
 * incapable of disagreeing. Group on the series alone and a batch of five moved instances
 * and one cancelled one collapses into "6 sessions now Tuesdays" — a sentence that tells
 * the parent the cancelled Tuesday is still on. Two kinds of news is two texts.
 */
type SeriesNews = 'live' | 'cancelled';

function seriesNews(change: CalendarChange): SeriesNews {
  return change.status === 'cancelled' ? 'cancelled' : 'live';
}

/**
 * The texts a batch of changes-still-ahead becomes: one per series-and-kind with two or
 * more instances in it, one per everything else.
 *
 * THE FORTNIGHT IS JUDGED ON THE GROUP, not on each instance, and that is the difference
 * between a sentence and a lie. Renaming a weekly class returns the whole year; the
 * sessions already behind are dropped one by one before this (they are not sessions
 * anybody is going to), but the ones ahead are all still true, and "2 sessions now
 * Tuesdays" — because only two of the six fall inside the next fourteen days — describes a
 * term that does not exist. So the LEAD decides whether the news is soon enough to
 * interrupt for, and the count is everything the batch said was coming.
 */
function offersOf(
  placed: readonly Placed[],
  integrationId: string,
  timeZone: string,
  now: Date,
  writes: Map<string, SnapshotWrite>,
  tooFarOff: CalendarAlertOutcome,
): Offer[] {
  const bySeriesNews = new Map<string, Placed[]>();
  const groups: Placed[][] = [];
  for (const one of placed) {
    const series = one.change.recurringEventId;
    if (series === undefined) {
      groups.push([one]);
      continue;
    }
    const key = `${seriesNews(one.change)}:${series}`;
    const existing = bySeriesNews.get(key);
    if (existing) existing.push(one);
    else {
      const started = [one];
      bySeriesNews.set(key, started);
      groups.push(started);
    }
  }
  const offers: Offer[] = [];
  for (const group of groups) {
    group.sort((a, b) => a.span.startMs - b.span.startMs);
    const lead = group[0];
    if (lead === undefined) continue;
    if (!withinAlertWindow(lead.change, lead.span, now)) {
      for (const member of group) {
        member.write(tooFarOff);
        remember(writes, member, null);
      }
      continue;
    }
    offers.push(offerOf(group, integrationId, timeZone, now));
  }
  return offers;
}

function offerOf(
  group: readonly Placed[],
  integrationId: string,
  timeZone: string,
  now: Date,
): Offer {
  const lead = group[0];
  if (lead === undefined) throw new Error('offerOf: an empty group');
  const series = lead.change.recurringEventId;
  const pendingSince = group.reduce<Date | null>(
    (oldest, member) =>
      member.pendingSince === null || (oldest !== null && oldest <= member.pendingSince)
        ? oldest
        : member.pendingSince,
    null,
  );
  if (series === undefined || group.length < SERIES_MIN_INSTANCES) {
    return {
      group,
      dedupeKey: calendarAlertDedupeKey(integrationId, lead.change.eventId, lead.change.updated),
      pendingSince,
      startMs: lead.span.startMs,
      render: () => renderCalendarAlert(lead.change, lead.span, timeZone, now, lead.previous),
      heldTitle: eventTitle(lead.change),
      heldLocation: vettedLocation(lead.change),
    };
  }
  // The LATEST stamp in the group, so the same set of instances always reduces to the same
  // key — which is how a held series re-offered two sweeps later claims the key its hold
  // never spent, rather than minting a second one.
  const stamp = group
    .map((member) => member.change.updated)
    .reduce((latest, one) => (one > latest ? one : latest));
  return {
    group,
    dedupeKey: calendarSeriesAlertDedupeKey(integrationId, series, seriesNews(lead.change), stamp),
    pendingSince,
    startMs: lead.span.startMs,
    render: () => renderCalendarSeriesAlert(group, timeZone, now),
    heldTitle: seriesTitle(group),
    // Deliberately none: one sentence about six sessions cannot honestly carry the
    // location of one of them.
    heldLocation: null,
  };
}

// ── The memory ───────────────────────────────────────────────────────────────

type SnapshotRow = typeof schema.calendarEventSnapshots.$inferSelect;
/** A row the table's CHECK guarantees is complete: dated, placed in time, and named. */
type PendingSnapshot = SnapshotRow & { pendingSince: Date; startAt: Date; heldTitle: string };

interface SnapshotWrite {
  eventId: string;
  recurringEventId: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  updatedStamp: string;
  status: string;
  pendingSince: Date | null;
  heldTitle: string | null;
  heldLocation: string | null;
  heldMovedFromAt: Date | null;
  heldMovedFromAllDay: boolean | null;
}

export interface PriorStart {
  startMs: number;
  allDay: boolean;
}

function isPending(row: SnapshotRow): row is PendingSnapshot {
  // The three travel together or not at all — `calendar_event_snapshots_held_check`. The
  // narrowing is the database's guarantee restated in the type system, not a filter that
  // could quietly drop work.
  return row.pendingSince !== null && row.startAt !== null && row.heldTitle !== null;
}

/** What Hale last said about the events on this page, and every text it still owes on this
 * connection — in one round trip, because the second half has to be read even when the
 * page is empty. */
async function readSnapshots(
  database: Database,
  integrationId: string,
  changes: readonly CalendarChange[],
): Promise<SnapshotRow[]> {
  const onThisPage = [...new Set(changes.map((change) => change.eventId))];
  const owed = isNotNull(schema.calendarEventSnapshots.pendingSince);
  return database
    .select()
    .from(schema.calendarEventSnapshots)
    .where(
      and(
        eq(schema.calendarEventSnapshots.integrationId, integrationId),
        onThisPage.length === 0
          ? owed
          : or(owed, inArray(schema.calendarEventSnapshots.eventId, onThisPage)),
      ),
    );
}

/** One upsert for the whole sweep. Keyed by event, so a page that mentions an event twice
 * writes the last thing the sweep decided about it rather than conflicting with itself. */
async function writeSnapshots(
  database: Database,
  integrationId: string,
  writes: Map<string, SnapshotWrite>,
  now: Date,
): Promise<void> {
  if (writes.size === 0) return;
  await database
    .insert(schema.calendarEventSnapshots)
    .values([...writes.values()].map((write) => ({ integrationId, ...write, updatedAt: now })))
    .onConflictDoUpdate({
      target: [
        schema.calendarEventSnapshots.integrationId,
        schema.calendarEventSnapshots.eventId,
      ],
      set: {
        recurringEventId: sql`excluded.recurring_event_id`,
        startAt: sql`excluded.start_at`,
        endAt: sql`excluded.end_at`,
        allDay: sql`excluded.all_day`,
        updatedStamp: sql`excluded.updated_stamp`,
        status: sql`excluded.status`,
        pendingSince: sql`excluded.pending_since`,
        heldTitle: sql`excluded.held_title`,
        heldLocation: sql`excluded.held_location`,
        heldMovedFromAt: sql`excluded.held_moved_from_at`,
        heldMovedFromAllDay: sql`excluded.held_moved_from_all_day`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

function remember(
  writes: Map<string, SnapshotWrite>,
  placed: { change: CalendarChange; span: EventSpan },
  hold: {
    since: Date;
    title: string;
    location: string | null;
    movedFrom: PriorStart | null;
  } | null,
): void {
  const movedFrom = hold?.movedFrom ?? null;
  writes.set(placed.change.eventId, {
    eventId: placed.change.eventId,
    recurringEventId: placed.change.recurringEventId ?? null,
    startAt: new Date(placed.span.startMs),
    endAt: new Date(placed.span.endMs),
    allDay: placed.span.allDay,
    updatedStamp: placed.change.updated,
    status: placed.change.status,
    pendingSince: hold?.since ?? null,
    heldTitle: hold?.title ?? null,
    heldLocation: hold?.location ?? null,
    // The instant and its shape travel together or not at all, which the table's second
    // CHECK is the enforcement of.
    heldMovedFromAt: movedFrom === null ? null : new Date(movedFrom.startMs),
    heldMovedFromAllDay: movedFrom === null ? null : movedFrom.allDay,
  });
}

/**
 * Whether this sighting is a MOVE, and what it moved from.
 *
 * A cancellation never is: "the Friday class was cancelled" is the whole of the news, and
 * "(was Thursday)" on top of it is a second fact the parent did not ask about. Neither is
 * a first sighting, which is what makes the snapshot read load-bearing rather than
 * decorative — remove it and every changed event reads as new.
 */
function movedFrom(
  prior: SnapshotRow | undefined,
  change: CalendarChange,
  span: EventSpan,
): PriorStart | null {
  if (prior === undefined) return null;
  if (change.status === 'cancelled') return null;
  const told = lastTold(prior);
  if (told === null) return null;
  return told.startMs === span.startMs ? null : told;
}

/**
 * The start the parent actually HEARD, which is not always the last one Hale saw.
 *
 * While a text is owed, the row's own `start_at` is the HELD start — true of the calendar
 * and never said to anybody. So a second move arriving before the hold clears has to
 * reach past it to the start the held text was going to say it moved FROM, or the
 * parenthetical names a time the parent was never told. A hold that was not about a move
 * (a first sighting the cap or quiet hours refused) means they have heard nothing at all,
 * and the next sighting is a first sighting again.
 */
function lastTold(prior: SnapshotRow): PriorStart | null {
  if (prior.pendingSince !== null) {
    return prior.heldMovedFromAt === null || prior.heldMovedFromAllDay === null
      ? null
      : { startMs: prior.heldMovedFromAt.getTime(), allDay: prior.heldMovedFromAllDay };
  }
  return prior.startAt === null ? null : { startMs: prior.startAt.getTime(), allDay: prior.allDay };
}

/** A held text, rebuilt from the memory into the shape the renderer takes. Nothing is
 * fetched from Google: the syncToken moved on long ago, and re-reading would only find a
 * calendar that has since changed again. */
function revive(
  row: PendingSnapshot,
  timeZone: string,
  write: (outcome: CalendarAlertOutcome) => void,
): Placed {
  const startAt = row.startAt;
  const endAt = row.endAt ?? startAt;
  const point = (at: Date) =>
    row.allDay ? { date: dayKeyOf(at, timeZone) } : { dateTime: at.toISOString() };
  return {
    change: {
      eventId: row.eventId,
      recurringEventId: row.recurringEventId ?? undefined,
      updated: row.updatedStamp,
      status:
        row.status === 'cancelled' || row.status === 'tentative' ? row.status : 'confirmed',
      title: row.heldTitle,
      start: point(startAt),
      end: point(endAt),
      location: row.heldLocation ?? undefined,
    },
    span: { startMs: startAt.getTime(), endMs: endAt.getTime(), allDay: row.allDay },
    // The prior's OWN shape, never this row's: an all-day start is a local midnight, and
    // read back under the current row's flag it renders as a clock of twelve that the
    // calendar never had.
    previous:
      row.heldMovedFromAt === null || row.heldMovedFromAllDay === null
        ? null
        : { startMs: row.heldMovedFromAt.getTime(), allDay: row.heldMovedFromAllDay },
    pendingSince: row.pendingSince,
    write,
  };
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
 * a `date` nor an `originalStartTime` — the shape of a deleted SINGLE event on an
 * incremental page, and the only shape that cannot be placed. Resolved ONCE
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
  if (isOver(span, now)) return false;
  if (change.status === 'cancelled') return true;
  return span.startMs <= now.getTime() + CALENDAR_ALERT_WINDOW_DAYS * 86_400_000;
}

/** An event that already finished, which is never worth a text whatever else is true of
 * it. Judged per INSTANCE and before anything is grouped: renaming a weekly class returns
 * the whole year, and last Tuesday is not a session anybody is going to. */
function isOver(span: EventSpan, now: Date): boolean {
  return span.endMs <= now.getTime();
}

// ── The sentence ─────────────────────────────────────────────────────────────

/** The two clamps that keep the body inside TWO GSM-7 segments once the full opt-out
 * paragraph is appended. Nothing else in the message is variable-length, so these are
 * what make that arithmetic a fact rather than a hope; the property test in this
 * module's suite is the proof. */
const TITLE_MAX = 60;
const LOCATION_MAX = 40;
const UNTITLED = 'Untitled';
/** What a cancellation calls an event it has no name for. A tombstone carries no
 * `summary` at all, and the recurring master's title is not on the incremental page to
 * borrow — "Untitled was cancelled" reads as a bug in Hale rather than as news. */
const UNTITLED_CANCELLED = 'An event';
/** And what a SERIES with nothing named in it is called. "An event: 6 sessions" is a
 * disagreement inside one sentence. */
const UNTITLED_SERIES = 'A repeating event';

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
  previous: PriorStart | null = null,
): string {
  const title = eventTitle(change);
  // One zone for everything, because an all-day span is already anchored at midnight in
  // it ({@link dayStartInZone}) — the day the parent typed IS the day this names.
  const day = asciiSpaces(formatDayHeading(new Date(span.startMs), timeZone, now));

  if (change.status === 'cancelled') {
    return endSentence(`${title} on ${day} was cancelled`);
  }
  if (previous !== null) return movedSentence(change, span, previous, title, day, timeZone, now);

  const when = span.allDay
    ? dayRange(span, day, timeZone, now)
    : `${day}, ${clockRange(span, timeZone, now)}`;
  return endSentence(`${title} is on your calendar for ${when}${placePhrase(change)}`);
}

/**
 * `Swim lessons moved to Thursday, Sep 17, 4:15-5:00 p.m. (was Wednesday, Sep 16).`
 *
 * The parenthetical is the whole point: an edit the parent made is a fact they already
 * know, and an edit the OTHER parent (or the gym) made is only legible as news if the
 * sentence says what changed. So when the DAY did not move the sentence must not be about
 * the day — "PA day moved to Friday, Sep 18 (was Friday, Sep 18)" names the one thing
 * that stayed the same, twice, and says nothing at all. Same-day edits say what actually
 * changed instead: the clock, or the loss or gain of one.
 *
 *   `Cartwheels Gym moved to 5:00-5:45 p.m. today (was 4:15).`
 *   `PA day moved to 9:00-10:00 a.m. on Friday, Sep 18 (was all day).`
 *   `PA day is now all day on Friday, Sep 18 (was 9:00 a.m.).`
 */
function movedSentence(
  change: CalendarChange,
  span: EventSpan,
  previous: PriorStart,
  title: string,
  day: string,
  timeZone: string,
  now: Date,
): string {
  const sameDay =
    dayKeyOf(new Date(span.startMs), timeZone) === dayKeyOf(new Date(previous.startMs), timeZone);
  if (sameDay) {
    const was = previousWhen(previous, span, timeZone);
    if (span.allDay) {
      // Never "today": "is now all day today" spends two words on the day it just said.
      return endSentence(
        `${title} is now all day on ${dayRange(span, day, timeZone, now)}${placePhrase(change)} (was ${was})`,
      );
    }
    const when =
      dayKeyOf(new Date(span.startMs), timeZone) === dayKeyOf(now, timeZone)
        ? 'today'
        : `on ${day}`;
    return endSentence(
      `${title} moved to ${clockRange(span, timeZone, now)} ${when}${placePhrase(change)} (was ${was})`,
    );
  }
  const when = span.allDay
    ? dayRange(span, day, timeZone, now)
    : `${day}, ${clockRange(span, timeZone, now)}`;
  const wasDay = asciiSpaces(formatDayHeading(new Date(previous.startMs), timeZone, now));
  return endSentence(`${title} moved to ${when}${placePhrase(change)} (was ${wasDay})`);
}

/**
 * What the parenthetical calls the start the parent was last told, on a day that did not
 * move: a clock, or the words for a start that never had one.
 *
 * An all-day start is a local midnight, so a clock is exactly what it must not be given —
 * "(was 12:00)" is a time the calendar never held. The a.m./p.m. is dropped only when the
 * new start is a clock too and says the same one: two of them in seven characters is how
 * a machine writes a time, not how a parent reads one.
 */
function previousWhen(previous: PriorStart, span: EventSpan, timeZone: string): string {
  if (previous.allDay) return 'all day';
  const was = clockParts(previous.startMs, timeZone);
  if (span.allDay) return `${was.clock} ${was.dayPeriod}`;
  const start = clockParts(span.startMs, timeZone);
  return was.dayPeriod === start.dayPeriod ? was.clock : `${was.clock} ${was.dayPeriod}`;
}

/**
 * `Swim lessons moved: 6 sessions now Tuesdays 5:00-5:45 p.m. starting Sep 22.`
 *
 * With `singleEvents=true` one edit to a weekly class is one change per instance, so the
 * only alternative to this sentence is six texts — or, once the per-sweep cap bites, five
 * texts and a silently dropped Tuesday. The count is the instances still AHEAD in this
 * batch, because the ones already behind are not sessions anybody is going to.
 *
 * The weekday-and-clock shape is claimed only when every instance really does share one.
 * A series whose instances scatter says the first one instead — a pattern that is not
 * there is the one thing this sentence must not invent.
 */
function renderCalendarSeriesAlert(
  group: readonly Placed[],
  timeZone: string,
  now: Date,
): string {
  const lead = group[0];
  if (lead === undefined) throw new Error('renderCalendarSeriesAlert: an empty group');
  const title = seriesTitle(group);
  const count = group.length;
  const from = shortDate(lead.span.startMs, timeZone, now);

  // The group is homogeneous by construction — {@link seriesNews} is its key — so the
  // lead speaks for all of it.
  if (seriesNews(lead.change) === 'cancelled') {
    return endSentence(`${title}: ${count} sessions were cancelled from ${from}`);
  }

  const moved = group.some((member) => member.previous !== null);
  const pattern = seriesPattern(group, timeZone, now);
  if (pattern !== null) {
    return endSentence(
      moved
        ? `${title} moved: ${count} sessions now ${pattern} starting ${from}`
        : `${title}: ${count} sessions on your calendar, ${pattern} starting ${from}`,
    );
  }
  const day = asciiSpaces(formatDayHeading(new Date(lead.span.startMs), timeZone, now));
  const first = lead.span.allDay ? day : `${day}, ${clockRange(lead.span, timeZone, now)}`;
  return endSentence(
    moved
      ? `${title} moved: ${count} sessions, the first on ${first}`
      : `${title}: ${count} sessions on your calendar, the first on ${first}`,
  );
}

/** `Tuesdays 5:00-5:45 p.m.`, `Tuesdays` for an all-day series, or nothing when the
 * instances do not actually share a weekday and a clock. */
function seriesPattern(
  group: readonly Placed[],
  timeZone: string,
  now: Date,
): string | null {
  const lead = group[0];
  if (lead === undefined) return null;
  const weekday = weekdayIn(lead.span.startMs, timeZone);
  const clock = lead.span.allDay ? '' : clockRange(lead.span, timeZone, now);
  for (const member of group) {
    if (member.span.allDay !== lead.span.allDay) return null;
    if (weekdayIn(member.span.startMs, timeZone) !== weekday) return null;
    if (!lead.span.allDay && clockRange(member.span, timeZone, now) !== clock) return null;
  }
  return clock === '' ? `${weekday}s` : `${weekday}s ${clock}`;
}

/** What to call a series: the first instance in it that carries a usable name. A
 * cancelled instance carries none at all, so a cancelled series often falls through every
 * member to the generic — which is the honest answer, not a hole in the sentence. */
function seriesTitle(group: readonly Placed[]): string {
  for (const member of group) {
    const named = usableTitle(member.change);
    if (named !== null) return named;
  }
  return UNTITLED_SERIES;
}

function weekdayIn(ms: number, timeZone: string): string {
  return asciiSpaces(
    new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(ms)),
  );
}

/** `Sep 22`, or `Jan 5, 2027` once the date leaves this year — the same other-year rule
 * `formatDayHeading` applies, without the weekday the surrounding sentence already said. */
function shortDate(ms: number, timeZone: string, now: Date): string {
  const yearOf = (at: Date) => dayKeyOf(at, timeZone).slice(0, 4);
  return asciiSpaces(
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: yearOf(new Date(ms)) === yearOf(now) ? undefined : 'numeric',
      timeZone,
    }).format(new Date(ms)),
  );
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
  // Google permits a timed event to carry no `end`, and {@link eventSpan} collapses such a
  // span onto its start. "11:00-11:00 a.m." is a typo where the start alone is the one
  // fact there is.
  if (span.endMs === span.startMs) return `${start.clock} ${start.dayPeriod}`;
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
  const place = vettedLocation(change);
  return place === null ? '' : ` at ${place}`;
}

/** The location the sentence is willing to say, and so the only form of it the memory is
 * allowed to keep. */
function vettedLocation(change: CalendarChange): string | null {
  if (change.location === undefined) return null;
  const place = gsm7(change.location);
  if (place === '' || place.length > LOCATION_MAX || place.includes('@')) return null;
  return place;
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

/**
 * What to call the event, once the parent's own words have been made safe to send.
 *
 * The '@' rule is the location's, for the location's reason: parents write the person
 * they owe a reply to into a title ("Email coach@gym.ca re Leo"), and a mailbox in a text
 * is a mailbox anyone holding the phone can write to (rule #1). Dropped whole rather than
 * scrubbed — a title with the address cut out of it is a sentence with a hole in it.
 */
function eventTitle(change: CalendarChange): string {
  return (
    usableTitle(change) ?? (change.status === 'cancelled' ? UNTITLED_CANCELLED : UNTITLED)
  );
}

/** The event's own name, or nothing when it has none Hale may say. */
function usableTitle(change: CalendarChange): string | null {
  const text = gsm7(change.title ?? '');
  if (text.includes('@')) return null;
  return clampTitle(text) || null;
}

/** Cut to the budget with an explicit ellipsis, so a parent can see that the calendar
 * said more than the text does. */
function clampTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX - 3).trimEnd()}...`;
}
