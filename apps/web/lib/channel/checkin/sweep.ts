import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  PRIVATE_EVENT_WHAT,
  type ScheduleEvent,
  channelScheduleReader,
} from '~/lib/channel/coach/tools';
import { f14Allowlist, f14Enabled } from '~/lib/channel/f14';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { nightlyOccasion } from '~/lib/channel/variant';
import { readinessQuestion } from '~/lib/registration/sequence/prepare-reply';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { dayKeyIn } from '~/lib/plan/spine';
import {
  type CheckInDecision,
  type CheckInSkipReason,
  type CheckInState,
  isEveningCheckInSlot,
  localDateKey,
  decideCheckIn,
  readCheckInState,
  recordCheckInAsk,
  recordCheckInCadence,
} from './cadence';
import {
  CHECK_IN_ASK_TEMPLATE_KEY,
  CHECK_IN_STEP_DOWN,
  CHECK_IN_STEP_DOWN_TEMPLATE_KEY,
  composeCheckInAsk,
} from './copy';

/**
 * VIL-353 · THE EVENING CHECK-IN — the one question Hale asks every day.
 *
 * "How did today go?" is the only write path Hale has for whether anything it suggested
 * actually WORKED. A calendar says when, an inbox says what is due, and neither of them
 * knows that the 8am swim class is the one this family will never make twice. So the
 * value of this sweep is not the message; it is the answer, and every decision below is
 * about earning one more of them.
 *
 * IT RIDES THE HOURLY NUDGE CRON, the way the intros, the plan check-in and the activity
 * follow-up do, and for their reasons: that cron already exists to decide whether to
 * interrupt a parent, it already runs at the cadence this needs, and a second Vercel slot
 * would be a second failure budget and a second place to forget the dark-launch flag.
 *
 * IT ASKS AT 20:00 LOCAL, WHICH IS THE LEGAL CLAMP (see EVENING_CHECK_IN_HOUR_LOCAL).
 *
 * IT NEVER SPEAKS OVER THE REGISTRATION MORNING, and that rail is a mechanism rather
 * than a courtesy. The readiness checklist is the one open question in this product that
 * is derived from the MESSAGE LEDGER: it stands only while its ask is Hale's last word to
 * that parent, and it closes the moment any outbound reaches them (registration/sequence/
 * prepare-reply.ts). A cheerful "how was today" at 20:17 the night before a 06:30 open
 * would therefore close the one question that morning depends on, and the parent's "yes,
 * all set" would be filed as a day note. So the sweep reads that question first — through
 * the owning module's own reader, so there is only ever one answer to whether it is
 * standing — and stays quiet when it is. Nothing else on the open-question list is
 * damaged by a message: an approval or an intro card outlives any number of them, and a
 * bare affirmative near two open questions is already handled by `soleOpenKind`.
 *
 * THE STATE MACHINE IS THE PREFS ROW, and the ladder inside it (cadence.ts) is a pure
 * function: the sweep decides nothing about silence, it only carries out the decision and
 * writes down what happened.
 */

/** Filter first, then cap — a cap-then-filter would starve every family past the oldest N
 * of their slot forever. Most hours select nobody at all.
 *
 * THE LADDER IS PART OF THE FILTER, and it has to be: the selection is ordered least
 * recently asked first, and the households the ladder has nothing to send are exactly the
 * ones that sit at the head of that order forever — a family who replied NO is never asked
 * again, so their `last_asked_at` never moves. Capping before the decision would spend the
 * bound on them every evening and leave a household that is actually due behind the same
 * wall each night. So every family in the slot is decided, and only the ones with something
 * to send are counted against this bound.
 *
 * WHICH N, when there are still more, is the selection's ORDER BY, so a household that
 * overflowed tonight is at the front of tomorrow's queue. `overflow` says how many were
 * left. */
export const MAX_CHECK_INS_PER_RUN = 100;

const DAY_MS = 86_400_000;

/**
 * THE ANCHOR'S OWN FLAG — the only change in this lane that reads NEW data into an
 * unprompted nightly message, so the only one worth being able to turn off without a
 * revert. It narrows; it never widens. The whole lane still sits behind F14.
 *
 * OFF IS NOT DEGRADED. Off is the deterministic day question, which is the message this
 * lane has shipped all along.
 *
 * STRICT equality on the literal 'true', the f14 gate's reason verbatim: `vercel env add`
 * from a piped `echo` stores a TRAILING NEWLINE, so a value that prints as `true` is
 * really `'true\n'` — and a truthiness check would read that as ON. Set it with
 * `printf '%s'`.
 */
export const CHECK_IN_ANCHOR_ENABLED_ENV = 'CHECK_IN_ANCHOR_ENABLED';

export function checkInAnchorEnabled(): boolean {
  return process.env[CHECK_IN_ANCHOR_ENABLED_ENV] === 'true';
}

/**
 * Why this evening's question named an activity, or did not.
 *
 * EVERY VALUE IS A REAL STATE AND THE SWEEP COUNTS IT (rule #11). "Nothing happened
 * today" and "something happened and Hale would not say what" are never the same number:
 * `private_event` climbing is a run to look at, and `placement_lane` is the number that
 * proves the evening anchor and the composed follow-up stayed out of each other's way.
 */
export type AnchorOutcome =
  /** Named. */
  | 'anchored'
  /** This household's first evening question ever — it prints the keywords and is never
   * anchored, so the anchor lane did not run rather than finding nothing. */
  | 'first_ask'
  /** CHECK_IN_ANCHOR_ENABLED is not 'true'. */
  | 'flag_off'
  /** Nothing of this family's started today before now. */
  | 'no_event_today'
  /** A teen's or a sensitive row. It exists and it is not Hale's to name — and saying
   * nothing at all is stronger than genericising it, because the evening message then
   * does not disclose that a private item existed. */
  | 'private_event'
  /** Hale put that one there, so the composed follow-up lane owns asking how it went. */
  | 'placement_lane'
  /** A family-wide row with no child on it. */
  | 'no_child'
  /** A title Hale cannot spell inside the budget. */
  | 'not_gsm7'
  /** Composed, measured, did not fit one segment with the opt-out on it. */
  | 'over_segment'
  /** The read threw. Counted rather than swallowed: a reader that started failing would
   * otherwise look exactly like a product where nothing ever happens. */
  | 'read_failed';

/**
 * What the activity reader found — the title, or the reason there is none.
 *
 * THE ABSENCE IS NAMED IN THE RETURN VALUE (rule #11) rather than being a bare null. The
 * sweep counts these, and a null that meant five different things would be a metric that
 * cannot tell a quiet Tuesday from a lane that stopped working.
 */
export type TodayActivity =
  | { anchor: string }
  | {
      anchor: null;
      reason: Extract<
        AnchorOutcome,
        'no_event_today' | 'private_event' | 'placement_lane' | 'no_child' | 'not_gsm7'
      >;
    };

export interface EveningCheckInResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  /** Families whose local clock is in the evening hour right now — ALL of them, including
   * the ones this run had no room for. */
  inSlot: number;
  /** Due tonight and left for tomorrow, because the slot held more households with
   * something to send than one run may carry. Counted rather than dropped silently: a
   * standing overflow is the signal that the bound needs raising or the hour spreading. */
  overflow: number;
  asked: number;
  /** Three lapsed asks: the parent was told Hale will ask weekly instead. */
  steppedDownToWeekly: number;
  /** Three more: Hale stopped, and said nothing about stopping. */
  dormant: number;
  /** In the slot, but the ladder had nothing to send tonight. */
  skipped: Record<CheckInSkipReason, number>;
  /** In the slot and due, but a registration readiness question was standing. */
  heldForRegistration: number;
  /** Refused by the outbound chokepoint, by reason. */
  held: Record<ProactiveHoldReason, number>;
  /** Already sent this evening — a second cron tick inside the same local hour. */
  duplicate: number;
  failed: number;
  /** One entry per household this run actually ASKED (the step-down notice asks nothing,
   * so it is not counted here). Same shape as `skipped` and `held`, for the same reason. */
  anchor: Record<AnchorOutcome, number>;
}

function emptyResult(enabled: boolean): EveningCheckInResult {
  return {
    enabled,
    inSlot: 0,
    overflow: 0,
    asked: 0,
    steppedDownToWeekly: 0,
    dormant: 0,
    skipped: { cadence_off: 0, asked_today: 0, not_due: 0 },
    heldForRegistration: 0,
    held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
    duplicate: 0,
    failed: 0,
    anchor: {
      anchored: 0,
      first_ask: 0,
      flag_off: 0,
      no_event_today: 0,
      private_event: 0,
      placement_lane: 0,
      no_child: 0,
      not_gsm7: 0,
      over_segment: 0,
      read_failed: 0,
    },
  };
}

export interface CheckInFamily {
  familyId: string;
  parentUserId: string;
  timeZone: string;
}

export interface EveningCheckInDeps {
  selectFamilies(database: Database): Promise<CheckInFamily[]>;
  /** The children this question may NAME — under-13s only, stripped at the source. */
  loadNamableChildren(database: Database, familyId: string, now: Date): Promise<string[]>;
  /**
   * The activity this evening's question may name, or the reason there is none.
   *
   * REQUIRED (rule #11), the reason `transport` is: a sweep that silently lost its reader
   * would step every household back to the generic ask and nobody would know — the
   * message would still send, still be one segment, and still read perfectly.
   *
   * The production implementation goes through `channelScheduleReader`, the door the
   * texted schedule already comes through, so its rows arrive ALREADY PROJECTED and this
   * file never names the table (teen-access-outbound.test.ts keeps that door count at
   * three).
   */
  readTodayActivity(
    database: Database,
    familyId: string,
    timeZone: string,
    now: Date,
  ): Promise<TodayActivity>;
  readState: typeof readCheckInState;
  buildGate(database: Database): OutboundGatePorts;
  /** The registration ladder's own reader for its own question (the one-reader-per-
   * question invariant). Non-nullable (rule #11): a sweep that could not see this
   * question would close it every evening without ever knowing. */
  readinessStanding: typeof readinessQuestion;
  dedupeActive: typeof dedupeActive;
  resolveSendablePhone: typeof resolveSendablePhone;
  /** REQUIRED (rule #11). A sweep that decides to ask and quietly sends nothing is the
   * worst version of this: the prefs row records an ask, the ladder counts the silence
   * that follows, and the family is stepped down for never answering a question nobody
   * put to them. */
  transport: ChannelTransport;
  recordSend(
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      templateKey: string;
      dedupeKey: string;
      providerMessageId: string;
      sentAt: Date;
    },
  ): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
  /** The parent's own text thread — REQUIRED and resolve-or-create, so the coach can see
   * the question it is about to be handed an answer to. */
  threadMessage: typeof threadProactiveMessage;
  recordAsk: typeof recordCheckInAsk;
  recordCadence: typeof recordCheckInCadence;
}

export async function runEveningCheckInSweep(
  database: Database,
  deps: EveningCheckInDeps = defaultEveningCheckInDeps(),
  now: Date = new Date(),
): Promise<EveningCheckInResult> {
  const allFamilies = f14Enabled();
  const allowlist = f14Allowlist();
  // The same dark-launch gate every other proactive surface uses: this question only
  // exists for a family already texting Hale, so there is no world in which F14 is off
  // and it should still fire.
  if (!allFamilies && allowlist.size === 0) return emptyResult(false);

  const result = emptyResult(true);
  const inSlot = (await deps.selectFamilies(database))
    .filter((family) => allFamilies || allowlist.has(family.familyId))
    .filter((family) => isEveningCheckInSlot(now, family.timeZone));
  result.inSlot = inSlot.length;

  const due: DueTonight[] = [];
  for (const family of inSlot) {
    try {
      const state = await deps.readState(database, family.familyId);
      const decision = decideCheckIn(state, now, family.timeZone);
      if (decision.kind === 'skip') result.skipped[decision.reason] += 1;
      else due.push({ family, state, decision });
    } catch (err) {
      result.failed += 1;
      console.error({ err, familyId: family.familyId }, 'evening check-in: state read failed');
    }
  }
  const carried = due.slice(0, MAX_CHECK_INS_PER_RUN);
  result.overflow = due.length - carried.length;

  for (const each of carried) {
    try {
      await runForFamily(database, deps, each, result, now);
    } catch (err) {
      result.failed += 1;
      // One family's bad data must not silence every family after it. Ids and enums only,
      // never the body and never the answer (rule #1).
      console.error(
        { err, familyId: each.family.familyId },
        'evening check-in: family sweep failed',
      );
    }
  }
  return result;
}

/** A household in its evening slot that the ladder has something to do about — the unit
 * MAX_CHECK_INS_PER_RUN is counted in. A skip never becomes one, which is the whole of
 * why the bound is applied after the decision and not before it. */
interface DueTonight {
  family: CheckInFamily;
  state: CheckInState;
  decision: Exclude<CheckInDecision, { kind: 'skip' }>;
}

async function runForFamily(
  database: Database,
  deps: EveningCheckInDeps,
  due: DueTonight,
  result: EveningCheckInResult,
  now: Date,
): Promise<void> {
  const { family, state, decision } = due;

  if (decision.kind === 'dormant') {
    // Nothing is sent, so nothing is gated: going quiet is not a message.
    await deps.recordCadence(database, {
      familyId: family.familyId,
      cadence: 'off',
      silentStreak: decision.silentStreak,
      now,
    });
    result.dormant += 1;
    await deps.audit(database, {
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'evening_check_in_stopped',
      targetTable: 'family_check_in_prefs',
      targetId: family.familyId,
      after: { cadence: 'off' },
    });
    return;
  }

  const verdict = await assertProactiveSendAllowed(
    { familyId: family.familyId, parentUserId: family.parentUserId, kind: 'evening_check_in', now },
    deps.buildGate(database),
  );
  if (!verdict.allowed) {
    // Held, not failed, and nothing is written: quiet hours end, and a household over its
    // budget tonight is under it tomorrow. The ladder must not count a silence for an
    // evening Hale never spoke.
    result.held[verdict.reason] += 1;
    return;
  }

  if ((await deps.readinessStanding(database, family.familyId, family.parentUserId, now)) !== null) {
    result.heldForRegistration += 1;
    return;
  }

  const dedupeKey =
    decision.kind === 'step_down'
      ? `evening_check_in:weekly:${family.familyId}:${(state.lastAskedAt ?? now).toISOString()}`
      : `evening_check_in:${family.familyId}:${localDateKey(now, family.timeZone)}`;
  if (await deps.dedupeActive(dedupeKey, database)) {
    result.duplicate += 1;
    return;
  }

  // Composed only AFTER the gate and the dedupe: a family already asked, or over budget,
  // must not cost a read of their children's names — nor, now, a read of their calendar.
  let message: string;
  if (decision.kind === 'step_down') {
    message = CHECK_IN_STEP_DOWN;
  } else {
    const found = await readAnchor(database, deps, family, decision.first, now);
    const ask = composeCheckInAsk({
      first: decision.first,
      childNames: await deps.loadNamableChildren(database, family.familyId, now),
      todayActivity: found.anchor,
      // Which of the five ways of asking this household reads tonight. The rotation
      // steps once per family-local day, so no family reads the same sentence two
      // evenings running (variant.ts).
      familyId: family.familyId,
      occasion: nightlyOccasion(now, family.timeZone),
    });
    message = ask.body;
    // A title that was offered and not used was refused by the BUDGET, and that is a
    // different fact from having nothing to name.
    result.anchor[found.anchor !== null && !ask.anchored ? 'over_segment' : found.outcome] += 1;
  }

  const to = await deps.resolveSendablePhone(database, family.parentUserId);
  if (!to) {
    // The gate just said this parent has a live channel, so there IS one — a missing
    // number here is a contradiction, not a state to paper over.
    throw new Error(`evening check-in: no send target for parent ${family.parentUserId}`);
  }

  const { providerMessageId } = await deps.transport.send({
    to,
    body: withOptOut(message, verdict.optOut),
  });
  const channelMessageId = await deps.recordSend(database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    templateKey: templateKeyFor(decision),
    dedupeKey,
    providerMessageId,
    sentAt: now,
  });
  const steppingDown = decision.kind === 'step_down';
  const actionTaken = steppingDown ? 'evening_check_in_stepped_down' : 'evening_check_in_sent';
  await deps.audit(database, {
    familyId: family.familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    after: { cadence: steppingDown ? 'weekly' : 'daily' },
  });
  // The composed sentence, never the wire body: the CASL line belongs on the wire and
  // nowhere else, and this thread is what the parent reads back and what the coach
  // re-reads on their next turn.
  await deps.threadMessage(database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    body: message,
  });

  if (decision.kind === 'step_down') {
    // `lastAskedAt` is deliberately NOT moved — see decideCheckIn — so the weekly rhythm
    // keeps measuring from the last real ask. `silentStreakSince` is what stops the lapse
    // this rung just answered being counted again by the first weekly question.
    await deps.recordCadence(database, {
      familyId: family.familyId,
      cadence: 'weekly',
      silentStreak: 0,
      silentStreakSince: now,
      now,
    });
    result.steppedDownToWeekly += 1;
    return;
  }
  await deps.recordAsk(database, {
    familyId: family.familyId,
    silentStreak: decision.silentStreak,
    now,
  });
  result.asked += 1;
}

/**
 * Tonight's anchor, and the one reason there is not one.
 *
 * The flag and the first-ask carve-out are decided HERE rather than inside the reader, so
 * a household that is not asking a pooled question never costs a calendar read at all.
 */
async function readAnchor(
  database: Database,
  deps: EveningCheckInDeps,
  family: CheckInFamily,
  first: boolean,
  now: Date,
): Promise<{ anchor: string | null; outcome: AnchorOutcome }> {
  // The first question a household is ever asked prints the keywords and is one pinned
  // sentence. It is not anchored, and saying so is not the same as finding nothing.
  if (first) return { anchor: null, outcome: 'first_ask' };
  if (!checkInAnchorEnabled()) return { anchor: null, outcome: 'flag_off' };
  try {
    const found = await deps.readTodayActivity(database, family.familyId, family.timeZone, now);
    return found.anchor === null
      ? { anchor: null, outcome: found.reason }
      : { anchor: found.anchor, outcome: 'anchored' };
  } catch (err) {
    // Ids and enums only, never a title and never the answer (rule #1) — the shape the
    // family sweep's own catch already uses.
    console.error({ err, familyId: family.familyId }, 'evening check-in: activity read failed');
    return { anchor: null, outcome: 'read_failed' };
  }
}

function templateKeyFor(decision: CheckInDecision): string {
  return decision.kind === 'step_down'
    ? CHECK_IN_STEP_DOWN_TEMPLATE_KEY
    : CHECK_IN_ASK_TEMPLATE_KEY;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/** The households an evening question could reach: settled SMS families with a primary
 * parent, minus the ones on their way out. Consent, enrolment, volume and the clock are
 * the GATE's business — selecting on them here would put the same policy in two places.
 *
 * LEAST RECENTLY ASKED FIRST, and a family never asked before everyone: the order is what
 * decides who MAX_CHECK_INS_PER_RUN leaves behind, and an unordered select would leave
 * behind whoever Postgres happened to return last — the same households every evening. */
async function selectCheckInFamilies(database: Database): Promise<CheckInFamily[]> {
  return database
    .select({
      familyId: schema.families.id,
      parentUserId: schema.users.id,
      timeZone: schema.users.timezone,
    })
    .from(schema.families)
    .innerJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.families.id),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .leftJoin(
      schema.familyCheckInPrefs,
      eq(schema.familyCheckInPrefs.familyId, schema.families.id),
    )
    .where(
      and(
        eq(schema.families.onboardingStage, 'sms_active'),
        isNull(schema.families.scheduledDeletionAt),
      ),
    )
    .orderBy(
      sql`${schema.familyCheckInPrefs.lastAskedAt} asc nulls first`,
      asc(schema.families.id),
    );
}

/**
 * The first names this question may use: the family's UNDER-13s.
 *
 * Rule #1's deterministic floor, applied AT THE SOURCE rather than as a redaction on the
 * way out — a 13+ child's name never enters the composer, so it cannot reach a template
 * even if a downstream check were removed. `deriveStage` is computed live from the date
 * of birth, so the gate cannot go stale on a birthday.
 */
async function readNamableChildren(
  database: Database,
  familyId: string,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows
    .filter((row) => deriveStage(row.dateOfBirth, now) !== 'teenager')
    .map((row) => row.name);
}

/**
 * The six subtractions that decide whether one event may be named, in the order their
 * refusals are reported.
 *
 * SUBTRACTIONS, NOT CHECKS. Each one removes a class of row from consideration rather
 * than adding a rule about what to say instead, and two of them are the privacy boundary
 * of this whole feature:
 *
 *   PRIVATE — a teen's or a sensitive row yields NO anchor at all. The nightly message
 *   then never discloses that a private item existed, which is stronger than genericising
 *   it and is the same property `childPhrase` already relies on: the absence of an anchor
 *   is indistinguishable from a quiet day.
 *
 *   PLACEMENT — Hale put that one there, and the composed follow-up lane already owns
 *   "you went to the thing I found, how was it" (channel/followup/run.ts). Both sweeps
 *   fire in the same hourly tick under separate gate budgets, so without this the same
 *   event would be named twice in thirteen hours in two different registers — and the
 *   parent's answer to the cheap one would silently convert the expensive one into an
 *   `already_discussed` skip.
 *
 *   NO CHILD — a family-wide row is an occasion with nobody on it, and the question is
 *   "how did swim go" about a child. It is also what keeps a co-parent's adult calendar
 *   item out of an unprompted 20:00 text to the other parent.
 */
function anchorRefusal(
  event: ScheduleEvent,
): Extract<AnchorOutcome, 'private_event' | 'placement_lane' | 'no_child' | 'not_gsm7'> | null {
  // The title check is belt AND braces: the projection already replaced a private row's
  // title, so matching the placeholder catches a row whose flags were read differently.
  if (event.teen || event.sensitive || event.title === PRIVATE_EVENT_WHAT) return 'private_event';
  if (event.source === 'placement') return 'placement_lane';
  if (event.childId === null) return 'no_child';
  if (!isPrintableGsm7Basic(event.title)) return 'not_gsm7';
  return null;
}

/**
 * What this family did today that Hale saw — through the PROJECTING door.
 *
 * `channelScheduleReader` is the reader the texted schedule already comes through, so a
 * teen's or a sensitive row arrives here as the placeholder with no location, decided by
 * the live age gate and never by a stored flag. Reusing it is what answers "this is a new
 * privacy-bearing read" by subtraction rather than with a second gate — and it is why
 * sweep.ts never names family_events.
 *
 * THE WINDOW IS A DAY EITHER SIDE AND THE TEST IS THE DAY KEY. A 24-hour window in each
 * direction covers every zone, and `dayKeyIn` — the house helper — decides which rows are
 * actually today, so nothing about midnight or a DST night is re-derived here.
 *
 * AMONG WHAT SURVIVES THE SUBTRACTIONS, THE LATEST THAT HAS ALREADY STARTED. One event,
 * one slot: Hale asks about what it saw, and 21:30's gymnastics has not happened yet at
 * 20:00. When nothing survives, the reason reported is the one that stopped the LATEST
 * candidate — the row the evening would otherwise have been about.
 */
async function readTodayActivity(
  database: Database,
  familyId: string,
  timeZone: string,
  now: Date,
): Promise<TodayActivity> {
  const events = await channelScheduleReader(database, now).eventsInWeek(
    familyId,
    new Date(now.getTime() - DAY_MS),
    new Date(now.getTime() + DAY_MS),
  );
  const today = events
    .filter(
      (event) =>
        dayKeyIn(event.startsAt, timeZone) === dayKeyIn(now, timeZone) &&
        event.startsAt.getTime() <= now.getTime(),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const latest = today[today.length - 1];
  if (!latest) return { anchor: null, reason: 'no_event_today' };
  const nameable = today.filter((event) => anchorRefusal(event) === null);
  const chosen = nameable[nameable.length - 1];
  if (chosen) return { anchor: chosen.title };
  return { anchor: null, reason: anchorRefusal(latest) as Exclude<
    ReturnType<typeof anchorRefusal>,
    null
  > };
}

export function defaultEveningCheckInDeps(): EveningCheckInDeps {
  return {
    selectFamilies: selectCheckInFamilies,
    loadNamableChildren: readNamableChildren,
    readTodayActivity,
    readState: readCheckInState,
    buildGate: buildOutboundGatePorts,
    readinessStanding: readinessQuestion,
    dedupeActive: (dedupeKey, database) => dedupeActive(dedupeKey, database),
    resolveSendablePhone,
    transport: createTwilioTransport(),
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: write.familyId,
          parentUserId: write.parentUserId,
          channel: 'sms',
          direction: 'out',
          category: 'evening_check_in',
          templateKey: write.templateKey,
          dedupeKey: write.dedupeKey,
          providerMessageId: write.providerMessageId,
          status: acceptedStatus('sms'),
          sentAt: write.sentAt,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('evening check-in: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    threadMessage: threadProactiveMessage,
    recordAsk: recordCheckInAsk,
    recordCadence: recordCheckInCadence,
  };
}
