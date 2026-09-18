import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
import { readinessQuestion } from '~/lib/registration/sequence/prepare-reply';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import {
  type CheckInDecision,
  type CheckInSkipReason,
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
 * WHICH N, when there are more, is decided by the selection's ORDER BY (least recently
 * asked first) rather than by whatever order Postgres happens to return, so a household
 * that overflowed tonight is at the front of tomorrow's queue instead of behind the same
 * hundred rows every evening. `overflow` says out loud how many were left. */
export const MAX_CHECK_INS_PER_RUN = 100;

export interface EveningCheckInResult {
  /** False when neither the flag nor the allowlist armed the sweep. */
  enabled: boolean;
  /** Families whose local clock is in the evening hour right now — ALL of them, including
   * the ones this run had no room for. */
  inSlot: number;
  /** In the slot and left for tomorrow, because the slot held more than one run may
   * carry. Counted rather than dropped silently: a standing overflow is the signal that
   * the bound needs raising or the hour needs spreading. */
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
  const families = inSlot.slice(0, MAX_CHECK_INS_PER_RUN);
  result.inSlot = inSlot.length;
  result.overflow = inSlot.length - families.length;

  for (const family of families) {
    try {
      await runForFamily(database, deps, family, result, now);
    } catch (err) {
      result.failed += 1;
      // One family's bad data must not silence every family after it. Ids and enums only,
      // never the body and never the answer (rule #1).
      console.error({ err, familyId: family.familyId }, 'evening check-in: family sweep failed');
    }
  }
  return result;
}

async function runForFamily(
  database: Database,
  deps: EveningCheckInDeps,
  family: CheckInFamily,
  result: EveningCheckInResult,
  now: Date,
): Promise<void> {
  const state = await deps.readState(database, family.familyId);
  const decision = decideCheckIn(state, now, family.timeZone);

  if (decision.kind === 'skip') {
    result.skipped[decision.reason] += 1;
    return;
  }
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

  if ((await deps.readinessStanding(database, family.familyId, now)) !== null) {
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
  // must not cost a read of their children's names.
  const message =
    decision.kind === 'step_down'
      ? CHECK_IN_STEP_DOWN
      : composeCheckInAsk({
          first: decision.first,
          childNames: await deps.loadNamableChildren(database, family.familyId, now),
        });

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

export function defaultEveningCheckInDeps(): EveningCheckInDeps {
  return {
    selectFamilies: selectCheckInFamilies,
    loadNamableChildren: readNamableChildren,
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
