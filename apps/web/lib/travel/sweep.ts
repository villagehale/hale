import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import { deriveStage } from '@hale/types';
import type { TravelQueryRefusal } from '~/lib/channel/activity/deidentify';
import { travelQueryFor } from '~/lib/channel/activity/deidentify';
import { type ActivityFinder, createActivityFinder } from '~/lib/channel/activity/lane';
import { type ActivityFamilyReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { f14Allowlist, f14Enabled, f14EnabledFor } from '~/lib/channel/f14';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  holdStatus,
} from '~/lib/channel/outbound-gate';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { activityClient } from '~/lib/pipeline/client';
import { TRAVEL_BRIEF_TEMPLATE_KEY, renderTravelBrief } from './copy';
import { localCalendarDay } from './detect';
import { travelBriefEnabled, travelBriefEnabledFor, travelBriefAllowlist } from './flag';
import { TRAVEL_SUBJECT, travelDestination, travelWindow } from './query';

/**
 * THE ONE TEXT A TRIP GETS, a week before it starts.
 *
 * It rides the hourly nudge cron, after the evening check-in and BEFORE the activity
 * follow-up, which is that route's own ordering rule: a stage that DISCHARGES a debt runs
 * last, and a stage that CHOOSES to interrupt runs before it. A travel brief chooses.
 *
 * EVERY TRIP CLOSES, EXACTLY ONCE, FOR A NAMED REASON — `sent`, `merged` or `overtaken`.
 * That is what makes the partial due index really empty and what makes each outcome
 * countable at the write that produces it, rather than by re-selecting closed rows every
 * hour to see whether they are still there.
 *
 * A HOLD IS NOT A CLOSE. A held trip stays open and comes back next tick, and its receipt
 * is KEYED — see {@link travelBriefHoldKey}.
 */

/** A week is when a parent starts planning, and it is the founder's confirmed number. */
export const TRAVEL_BRIEF_LEAD_DAYS = 7;

/**
 * How many trips get the full treatment in one tick.
 *
 * Three shallow finder runs at ~30s each fit the 300-second nudge route beside the
 * activity sweep's single deep pass. If the route starts dying this is the knob and it
 * drops to 1 before anything else changes — the trips stay due and come back next hour,
 * which costs a family an hour rather than a text.
 */
export const MAX_TRIPS_PER_RUN = 3;

/**
 * The coarse SQL prefilter's bound. The DUE decision is made on the PARENT's calendar day
 * and no timezone is more than a day from UTC, so a day of slack on each side is a
 * superset of every family's window — and a bounded one, unlike selecting the whole open
 * set.
 */
const PREFILTER_SLACK_DAYS = 1;

/** THE CORRECTNESS GUARD. One text per trip, forever, enforced by a unique index rather
 * than by a read a concurrent tick can race. */
export function travelBriefDedupeKey(tripId: string): string {
  return `travel_brief:${tripId}`;
}

/**
 * KEYED, and NOT `dedupeKey: null` — do not copy `email-alert.ts`'s suppression row here
 * without reading this.
 *
 * That row keeps its key null because an email alert is ONE-SHOT: the Gmail cursor moved
 * past the message the moment the sweep read it, so one hold is one row forever. A due
 * trip is re-selected HOURLY FOR UP TO SEVEN DAYS, so the same copy writes ~11 rows a
 * night for `quiet_hours` and up to 168 per trip for `not_enrolled`. That is not a cap
 * bug — `countFamilyProactiveSends` counts SENT_STATUSES only — it is a receipts ledger
 * full of noise, on the one surface a support agent reads.
 *
 * And it cannot block the send it records, for two independent reasons: the send's key is
 * a different string, and `dedupeActive` reads CONSUMED_SEND_STATUSES only, which no
 * `suppressed_*` status is in. Both are stated because either one alone would be enough,
 * and a maker who changed one should find the other.
 */
export function travelBriefHoldKey(tripId: string, reason: ProactiveHoldReason): string {
  return `travel_brief_hold:${tripId}:${reason}`;
}

export interface TravelBriefResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  due: number;
  sent: number;
  /** Trips closed `merged` into someone else's text — the flight folding into the hotel. */
  merged: number;
  /** The youngest child on file is 13+, so the sweep never searches at all. */
  teenOnlyHousehold: number;
  /**
   * The family has no `children` rows, so `stage` is null and `child_fare` needed none.
   * Without this the query would go out with a null stage and no name to read; stop
   * instead, and do not search.
   */
  noChildrenOnFile: number;
  /** BY REASON, because each one is a different fix: a child called Paris and a trip to
   * Paris is `names_a_person`, and a composer that ran long is not. */
  queryRefused: Record<TravelQueryRefusal, number>;
  held: Record<ProactiveHoldReason, number>;
  /** The finder came back `{ found: false }` for a reason that is not `no_picks`. */
  searchFailed: number;
  /** The search RAN and there is nothing on. Not a failure, and the trip is left OPEN — a
   * search that found nothing is not a brief the parent received. */
  noPicks: number;
  /** `travelBriefViolations` was non-empty. Its own count, because a body the gates had
   * already passed and the composer still could not back is a bug in CODE. */
  refusedAtRender: number;
  /** No phone, no recipient — a broken row, not a hold. */
  unsendable: number;
  /**
   * A SEND FOR THIS TRIP ALREADY EXISTS AND THE TRIP IS STILL OPEN. Either the cost guard
   * found the row — a tick that sent and then died before the close, which leaves the
   * trip open for up to seven days until `overtaken` takes it — or the claim's unique
   * index did, which is a concurrent tick mid-send. One text still goes out either way;
   * this is the counter that says so, because `due` minus `sent` with nothing behind it is
   * the silent early return rule #11 forbids.
   */
  alreadyClaimed: number;
  /** `starts_on` passed while the trip was still open. Counted at the write that closes
   * it. */
  overtaken: number;
  failed: number;
}

export function emptyTravelBriefResult(enabled: boolean): TravelBriefResult {
  return {
    enabled,
    due: 0,
    sent: 0,
    merged: 0,
    teenOnlyHousehold: 0,
    noChildrenOnFile: 0,
    queryRefused: {
      empty_subject: 0,
      subject_too_long: 0,
      window_too_long: 0,
      names_a_person: 0,
      destination_unusable: 0,
    },
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    searchFailed: 0,
    noPicks: 0,
    refusedAtRender: 0,
    unsendable: 0,
    alreadyClaimed: 0,
    overtaken: 0,
    failed: 0,
  };
}

/**
 * WHAT THE SWEEP NEEDS. Every one is non-nullable (rule #11): a sweep that could be wired
 * with the finder or the transport absent is a sweep that can silently do nothing.
 */
export interface TravelBriefDeps {
  /** REQUIRED. The whole point of this sweep is that the search actually runs. */
  finder: ActivityFinder;
  reader: ActivityFamilyReader;
  /**
   * The household's first names, split by the age gate — ONE read of the children table
   * rather than two, because the namable list and the teen list are the same query asked
   * twice. `deriveStage` is computed live from the date of birth, so neither can go stale
   * on a birthday.
   */
  readChildNames(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ namable: string[]; teens: string[] }>;
  buildGate(database: Database): OutboundGatePorts;
  parentTimeZone(database: Database, parentUserId: string): Promise<string>;
  resolvePhone: typeof resolveSendablePhone;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
  dedupeActive: typeof dedupeActive;
}

interface OpenTrip {
  id: string;
  familyId: string;
  parentUserId: string;
  destinationCity: string;
  destinationRegion: string | null;
  startsOn: string;
  endsOn: string;
}

/** `2026-09-12` + n days, as a calendar day. Plain date arithmetic: these are wall-clock
 * days at the destination, never instants. */
function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export async function runTravelBriefSweep(
  database: Database,
  deps: TravelBriefDeps = defaultTravelBriefDeps(),
  now: Date = new Date(),
): Promise<TravelBriefResult> {
  // BOTH FLAGS. F14 governs whether Hale may start a conversation at all and this one
  // governs whether this class exists; neither is a substitute for the other, and the
  // per-family read below applies both.
  const armed =
    (f14Enabled() || f14Allowlist().size > 0) &&
    (travelBriefEnabled() || travelBriefAllowlist().size > 0);
  if (!armed) return emptyTravelBriefResult(false);

  const result = emptyTravelBriefResult(true);
  const horizon = addDays(
    now.toISOString().slice(0, 10),
    TRAVEL_BRIEF_LEAD_DAYS + PREFILTER_SLACK_DAYS,
  );
  const open = (await database
    .select({
      id: schema.familyTrips.id,
      familyId: schema.familyTrips.familyId,
      parentUserId: schema.familyTrips.parentUserId,
      destinationCity: schema.familyTrips.destinationCity,
      destinationRegion: schema.familyTrips.destinationRegion,
      startsOn: schema.familyTrips.startsOn,
      endsOn: schema.familyTrips.endsOn,
    })
    .from(schema.familyTrips)
    .where(and(isNull(schema.familyTrips.closedAt), lte(schema.familyTrips.startsOn, horizon)))
    .orderBy(asc(schema.familyTrips.startsOn))) as OpenTrip[];

  // ONE TRIP PER FAMILY PER TICK, and it is the EARLIEST — which is what makes the overlap
  // collapse below well defined rather than a race between two rows about the same trip.
  const earliestByFamily = new Map<string, OpenTrip>();
  for (const trip of open) {
    if (!f14EnabledFor(trip.familyId) || !travelBriefEnabledFor(trip.familyId)) continue;

    // THE PARENT'S CALENDAR DAY, never UTC: a boundary computed on the wrong clock is one
    // that is wrong for seven hours of every day.
    const timeZone = await deps.parentTimeZone(database, trip.parentUserId);
    const today = localCalendarDay(now, timeZone);

    if (trip.startsOn < today) {
      // OVERTAKEN. It closes with a NULL message id, which the COALESCE'd CHECK permits
      // and the other two reasons forbid: a trip nobody was told about must never read as
      // one they were. Counted HERE, at the write, so it is counted exactly once.
      await database
        .update(schema.familyTrips)
        .set({ closedAt: now, closedReason: 'overtaken' })
        .where(eq(schema.familyTrips.id, trip.id));
      result.overtaken += 1;
      continue;
    }
    if (trip.startsOn > addDays(today, TRAVEL_BRIEF_LEAD_DAYS)) continue;
    if (!earliestByFamily.has(trip.familyId)) earliestByFamily.set(trip.familyId, trip);
  }

  // FILTER FIRST, THEN CAP. A cap-then-filter would starve every family past the oldest N
  // forever.
  const due = [...earliestByFamily.values()].slice(0, MAX_TRIPS_PER_RUN);
  result.due = due.length;

  for (const trip of due) {
    try {
      await briefOne(database, deps, trip, result, now);
    } catch (err) {
      result.failed += 1;
      // The trip stays OPEN, so the next tick tries again. Ids and enums only — never the
      // city and never the body (rule #1).
      console.error(
        { err: err instanceof Error ? err.constructor.name : 'unknown', tripId: trip.id },
        'travel brief: the tick failed - trip left open for the next one',
      );
    }
  }
  return result;
}

async function briefOne(
  database: Database,
  deps: TravelBriefDeps,
  trip: OpenTrip,
  result: TravelBriefResult,
  now: Date,
): Promise<void> {
  const dedupeKey = travelBriefDedupeKey(trip.id);
  // The cost guard, and it runs BEFORE the gate so a trip that already has its text costs
  // no consent read. A row here behind an OPEN trip is the crash gap: a tick that sent and
  // died before the close. Named rather than returned silently -- see `alreadyClaimed`.
  if (await deps.dedupeActive(dedupeKey, database)) {
    result.alreadyClaimed += 1;
    return;
  }

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: trip.familyId,
      parentUserId: trip.parentUserId,
      kind: 'travel_brief',
      now,
    },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    // A RECEIPT, keyed once per trip per reason. See travelBriefHoldKey.
    await database
      .insert(schema.channelMessages)
      .values({
        familyId: trip.familyId,
        parentUserId: trip.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'travel_brief',
        templateKey: TRAVEL_BRIEF_TEMPLATE_KEY,
        dedupeKey: travelBriefHoldKey(trip.id, verdict.reason),
        status: holdStatus(verdict.reason),
      })
      .onConflictDoNothing();
    result.held[verdict.reason] += 1;
    return;
  }

  // Read only AFTER the gate and the dedupe: a family over their budget must not cost a
  // read of their children's names, let alone a web search.
  const [stage, householdNames, names] = await Promise.all([
    deps.reader.stage(database, trip.familyId, null),
    deps.reader.householdNames(database, trip.familyId),
    deps.readChildNames(database, trip.familyId, now),
  ]);

  if (stage === null) {
    // No children on file at all. `child_fare` needed none, so a trip can reach here for a
    // household Hale knows nothing about — and a search with a null stage and no name to
    // read is not a search worth running.
    result.noChildrenOnFile += 1;
    return;
  }
  if (stage === 'teenager') {
    // R6, and it is about NOT SEARCHING rather than about not sending. `find_activities`
    // is `touchesChildContent: true` precisely so the guarded invoker refuses a 13+
    // child-scoped web search; this path does not go through that invoker, so it enforces
    // the same rule itself.
    result.teenOnlyHousehold += 1;
    return;
  }

  const deidentified = travelQueryFor({
    subject: TRAVEL_SUBJECT,
    window: travelWindow(trip.startsOn, trip.endsOn),
    destination: travelDestination(trip.destinationCity, trip.destinationRegion),
    stage,
    householdNames,
  });
  if (!deidentified.ok) {
    result.queryRefused[deidentified.refusal] += 1;
    console.error(
      { tripId: trip.id, refusal: deidentified.refusal },
      'travel brief: the destination query will not cross the border',
    );
    return;
  }

  const found = await deps.finder.find(deidentified.query);
  if (!found.found) {
    if (found.reason === 'no_picks') {
      // The search ran and there is nothing on. The trip is LEFT OPEN: a search that found
      // nothing is not a brief the parent received, and tomorrow's search may differ.
      result.noPicks += 1;
      return;
    }
    result.searchFailed += 1;
    console.error({ tripId: trip.id, reason: found.reason }, 'travel brief: the search failed');
    return;
  }

  let body: string;
  try {
    body = renderTravelBrief({
      city: trip.destinationCity,
      startsOn: trip.startsOn,
      endsOn: trip.endsOn,
      childNames: names.namable,
      picks: found.picks,
      teenNames: names.teens,
    });
  } catch (err) {
    result.refusedAtRender += 1;
    console.error(
      { tripId: trip.id, err: err instanceof Error ? err.message : 'unknown' },
      'travel brief: the composed body was refused',
    );
    return;
  }

  // CLAIM FIRST, by the insert rather than by a read a concurrent tick can race. The
  // dedupe read above is the cost guard; this is the correctness one.
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: trip.familyId,
      parentUserId: trip.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'travel_brief',
      templateKey: TRAVEL_BRIEF_TEMPLATE_KEY,
      dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) {
    // The other tick won the unique index and is mid-send. Same fact, same counter: this
    // tick sends nothing and the trip stays open for the one that did.
    result.alreadyClaimed += 1;
    return;
  }

  const to = await deps.resolvePhone(database, trip.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so this is a contradiction
    // between two readers of the same table. Recorded on the claimed row rather than
    // thrown: leaving it queued forever would read as a text in flight.
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'no_send_target' })
      .where(eq(schema.channelMessages.id, claimed.id));
    result.unsendable += 1;
    return;
  }

  let providerMessageId: string;
  try {
    ({ providerMessageId } = await deps.transport.send({
      to,
      body: withOptOut(body, verdict.optOut),
    }));
  } catch (err) {
    const code = err instanceof TwilioSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    result.failed += 1;
    console.error({ tripId: trip.id, code }, 'travel brief: the provider refused the text');
    return;
  }

  await database
    .update(schema.channelMessages)
    .set({ providerMessageId })
    .where(eq(schema.channelMessages.id, claimed.id));

  // R4 · OVERLAP COLLAPSE, at read rather than in the schema. The flight and the hotel for
  // one trip are two emails, two extractions and two rows, with dates that often differ by
  // a day — one piece of news that must spend one slot, not several. The calendar alert's
  // series collapse, applied to the same problem. Every merged row carries the SAME
  // message id, so the receipt for each of them is the text the parent actually got.
  const merged = await database
    .update(schema.familyTrips)
    .set({ closedAt: now, closedReason: 'merged', briefChannelMessageId: claimed.id })
    .where(
      and(
        eq(schema.familyTrips.familyId, trip.familyId),
        isNull(schema.familyTrips.closedAt),
        ne(schema.familyTrips.id, trip.id),
        lte(schema.familyTrips.startsOn, trip.endsOn),
        gte(schema.familyTrips.endsOn, trip.startsOn),
      ),
    )
    .returning({ id: schema.familyTrips.id });

  await database
    .update(schema.familyTrips)
    .set({ closedAt: now, closedReason: 'sent', briefChannelMessageId: claimed.id })
    .where(eq(schema.familyTrips.id, trip.id));

  // The composed sentence, not the wire body — the CASL line belongs on the wire, and the
  // coach re-reads this row next turn.
  await deps.threadMessage(database, {
    familyId: trip.familyId,
    parentUserId: trip.parentUserId,
    body,
  });

  await database.insert(schema.auditLog).values({
    familyId: trip.familyId,
    actor: 'system',
    actionTaken: 'travel_brief_sent',
    targetTable: 'channel_messages',
    targetId: claimed.id,
    // COUNTS, NOT NAMES. Never the city, never the venues, never the dates: an audit row a
    // support agent can read is a copy of the text in a table that is never redacted.
    after: { picks: found.picks.length, merged: merged.length },
  });

  result.sent += 1;
  result.merged += merged.length;
}

/** The under-13s' first names and the 13+ names, from ONE read. The age gate is
 * `deriveStage` over the date of birth, computed live so it cannot go stale on a
 * birthday. */
async function readChildNames(
  database: Database,
  familyId: string,
  now: Date,
): Promise<{ namable: string[]; teens: string[] }> {
  const rows = await database
    .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const namable: string[] = [];
  const teens: string[] = [];
  for (const row of rows) {
    (deriveStage(row.dateOfBirth, now) === 'teenager' ? teens : namable).push(row.name);
  }
  return { namable, teens };
}

export function defaultTravelBriefDeps(): TravelBriefDeps {
  return {
    // THE SHALLOW LANE, not the deep pass. A travel brief names a CITY, not a venue: there
    // is no one operator's site to open, and the inline lane's picks already carry the
    // `when` and the `price` in the source's own words.
    finder: createActivityFinder(activityClient),
    reader: productionActivityFamilyReader(),
    readChildNames,
    buildGate: buildOutboundGatePorts,
    // The SAME reader the gate judges quiet hours with, so the day the due set is computed
    // on and the hour the gate refused at can never disagree.
    parentTimeZone: (database, parentUserId) =>
      buildOutboundGatePorts(database).parentTimeZone(parentUserId),
    resolvePhone: resolveSendablePhone,
    transport: createTwilioTransport(),
    threadMessage: threadProactiveMessage,
    dedupeActive,
  };
}
