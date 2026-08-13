import Anthropic from '@anthropic-ai/sdk';
import { HOT_SMS_CLIENT_OPTIONS } from '~/lib/pipeline/client';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { ChannelMessageReceivedPayload } from '@hale/tools-contracts';
import { productionOffDomainLane } from '~/lib/channel/off-domain/lane';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { UNDO_WINDOW_HOURS, reverseExecutedCalendarAction } from '~/lib/actions/reverse-calendar';
import { approveDraftedAction } from '~/lib/actions/approve';
import { declineDraftedAction } from '~/lib/actions/decline';
import type { FamilyRole } from '~/lib/channel/role-scope';
import { defaultHealthReplyDeps } from '~/lib/health/reply';
import { defaultSequenceReplyDeps } from '~/lib/registration/sequence/reply';
import { getQueue } from '~/lib/queue';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { productionChannelCoach } from '~/lib/channel/coach/runtime';
import { defaultPlanOfferPorts, recordPlanOffer } from '~/lib/channel/plan/offer';
import { defaultPlanReplyDeps } from '~/lib/channel/plan/reply';
import type { ApprovalSpine, PendingAction, SpineOutcome, SpineRefusal } from './approval';
import { defaultVillageIntroReplyDeps } from '~/lib/village/intros/reply';
import { defaultEmailCaptureDeps } from '~/lib/channel/email-capture/reply';
import {
  approvalHandler,
  emailCaptureHandler,
  healthReplyHandler,
  planReplyHandler,
  sequenceReplyHandler,
  villageIntroHandler,
} from './handlers';
import {
  type ChannelRouterDeps,
  type DeterministicHandler,
  type InboundContext,
  routeChannelMessage,
} from './route';
import type { SmokeAlarmClaim } from './smoke-alarm';
import { createTurnApology } from './apology';
import type { InboundTurnLedger } from './turn-ledger';

/**
 * VIL-220 · C1 — the production wiring. The one place the router meets real tables, a
 * real provider, and the real approvals spine; every module beside it takes its
 * collaborators as arguments so the tests never do.
 */

/**
 * Everything the router needs about one inbound, in a single load.
 *
 * The BODY is read from the ledger row rather than the job, which is why the queue
 * payload can stay pointers-only: a parent's words live in exactly one place and never
 * pass through pg-boss (rule #1).
 */
export async function loadInboundContext(
  database: Database,
  job: ChannelMessageReceivedPayload,
): Promise<InboundContext | null> {
  const [message] = await database
    .select({ body: schema.channelMessages.body, familyId: schema.channelMessages.familyId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, job.channel_message_id))
    .limit(1);

  // A row that is missing, empty, or belongs to another family is not routable. The
  // family re-check is the rule #1 backstop: the job is the only thing asserting whose
  // message this is, and a mismatch must fail closed rather than answer the wrong
  // household.
  if (!message?.body || message.familyId !== job.family_id) return null;

  const [role, primaryParentName, phoneE164] = await Promise.all([
    memberRole(database, job.family_id, job.parent_user_id),
    primaryParentDisplayName(database, job.family_id),
    resolveSendablePhone(database, job.parent_user_id),
  ]);

  return { body: message.body, role, primaryParentName, phoneE164 };
}

async function memberRole(
  database: Database,
  familyId: string,
  userId: string,
): Promise<FamilyRole | null> {
  const [row] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.userId, userId),
      ),
    )
    .limit(1);
  return row ? (row.role as FamilyRole) : null;
}

/** Who a caregiver is pointed at, mirroring M6's own resolution. */
async function primaryParentDisplayName(
  database: Database,
  familyId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return row?.name ?? null;
}

/**
 * The approvals spine, bound to the SAME functions the app's buttons call.
 *
 * Nothing here re-implements a precondition. `approveDraftedAction` still enforces the
 * reviewer verdict (rule #3) and still enqueues rather than executing;
 * `reverseExecutedCalendarAction` still owns the 24h window. A text and a tap therefore
 * cannot diverge on what is allowed — which matters most for the audit trail, since
 * both paths write the same rows (rule #6).
 */
export function defaultApprovalSpine(): ApprovalSpine {
  return {
    /**
     * OLDEST FIRST — deliberately the reverse of the app's approvals queue, which shows
     * newest-drafted first. A text conversation is append-only: the numbered list Hale
     * sent is still on the parent's screen when they answer it, so the order must be
     * one a NEW draft cannot renumber. Ascending draftedAt is that order; descending
     * would shift every ordinal the moment another draft landed.
     */
    listPending: async (database, familyId): Promise<PendingAction[]> => {
      const rows = await database
        .select({ id: schema.actions.id, actionType: schema.actions.actionType })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.familyId, familyId),
            eq(schema.actions.userVisibleState, 'drafted_for_approval'),
          ),
        )
        .orderBy(asc(schema.actions.draftedAt))
        .limit(50);
      return rows.map((row) => ({ actionId: row.id, actionType: row.actionType }));
    },

    /**
     * The most recent action still inside the undo window. Only the state and the
     * window are filtered here; whether the action is of a reversible TYPE is left to
     * `reverseExecutedCalendarAction`, so its list stays the only one.
     */
    latestUndoable: async (database, familyId, now): Promise<PendingAction | null> => {
      const cutoff = new Date(now.getTime() - UNDO_WINDOW_HOURS * 60 * 60 * 1000);
      const [row] = await database
        .select({ id: schema.actions.id, actionType: schema.actions.actionType })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.familyId, familyId),
            eq(schema.actions.userVisibleState, 'autonomous'),
            gte(schema.actions.executedAt, cutoff),
            isNull(schema.actions.revertedAt),
          ),
        )
        .orderBy(desc(schema.actions.executedAt))
        .limit(1);
      return row ? { actionId: row.id, actionType: row.actionType } : null;
    },

    approve: async (database, args) => {
      const queue = await getQueue();
      const result = await approveDraftedAction(database, queue, args);
      return result.status === 202 ? { ok: true } : refused(result.error);
    },
    decline: async (database, args) => {
      const result = await declineDraftedAction(database, args);
      return result.status === 200 ? { ok: true } : refused(result.error);
    },
    undo: async (database, args) => {
      const result = await reverseExecutedCalendarAction(database, args);
      return result.status === 200 ? { ok: true } : refused(result.error);
    },
  };
}

/**
 * The route's own error keys, translated into the states a parent can be told about.
 *
 * Only the four that describe a REAL state a parent can act on (or stop acting on) are
 * named; a 404/403, or any key not listed, is a row that vanished or was never ours —
 * genuinely a breakage, and the one case the failure template still answers honestly.
 * Unmapped-by-default rather than unmapped-by-omission: a new error key gets the safe
 * "something went wrong" line until someone writes it a sentence.
 */
const SPINE_REFUSALS: Record<string, SpineRefusal> = {
  action_not_awaiting_approval: 'already_resolved',
  action_not_reviewer_approved: 'not_reviewer_approved',
  undo_window_expired: 'undo_window_expired',
  action_not_reversible: 'not_reversible',
  no_reversal_handle: 'not_reversible',
};

function refused(error: string): SpineOutcome {
  return { ok: false, reason: SPINE_REFUSALS[error] ?? 'unavailable' };
}

/**
 * The handler chain, in the order it runs — narrow claimers before broad ones. See
 * handlers.ts for why "yes" resolves the way it does and why registration is last.
 */
export function defaultHandlers(): DeterministicHandler[] {
  return [
    villageIntroHandler(defaultVillageIntroReplyDeps()),
    approvalHandler(defaultApprovalSpine()),
    emailCaptureHandler(defaultEmailCaptureDeps()),
    healthReplyHandler(defaultHealthReplyDeps()),
    planReplyHandler(defaultPlanReplyDeps()),
    sequenceReplyHandler(defaultSequenceReplyDeps()),
  ];
}

let screenAnthropic: Anthropic | undefined;

/**
 * The screen's client, resolved LAZILY — a function, not a value, for the reason the
 * coach runtime states: these deps are built for EVERY inbound text, including the ones
 * a deterministic handler answers with no model at all, so a missing ANTHROPIC_API_KEY
 * must never be what stops a parent approving something. Deferring it also buys the
 * honest `client_unavailable` reading instead of a thrown route.
 */
function screenClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  screenAnthropic ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return screenAnthropic;
}

/** VIL-273 / boundary v3 — the off-domain lane: the cheap screen, and the composer that
 * answers whatever it puts in `off_domain_general`. Both run on the same lazy client. */
function defaultOffDomainLane(database: Database) {
  return productionOffDomainLane(database, screenClient);
}

/**
 * The audit action the smoke alarm writes. A DATA value: it is what a PIPEDA access
 * request renders and what the dedupe reads back, so it is never renamed with the code.
 */
export const SMOKE_ALARM_ACTION = 'smoke_alarm_fired';

/**
 * The smoke alarm's memory, in audit_log — no new table and no migration.
 *
 * Rule #6 already requires an immutable row for the act, so the row that RECORDS the
 * alarm is the same row that stops a queue re-drive from ringing it again. `familyId` is
 * in the read as well as the message id: it is the leading column of the only index this
 * table has, and the router's own rule-#1 habit of scoping every lookup to the family
 * the job claims.
 *
 * The write is the alarm's second audit row, not its only one — `sendReply` has already
 * written `sms_reply_sent` for the text itself. This one records the DECISION, which is
 * the reviewable thing: Hale answered a parent without composing anything.
 */
export function auditSmokeAlarmClaim(database: Database): SmokeAlarmClaim {
  return {
    alreadyFired: async ({ familyId, channelMessageId }) => {
      const [row] = await database
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.familyId, familyId),
            eq(schema.auditLog.actionTaken, SMOKE_ALARM_ACTION),
            eq(schema.auditLog.targetTable, 'channel_messages'),
            eq(schema.auditLog.targetId, channelMessageId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    recordFired: async ({ familyId, parentUserId, channelMessageId }) => {
      await database.insert(schema.auditLog).values({
        familyId,
        actor: parentUserId,
        actionTaken: SMOKE_ALARM_ACTION,
        targetTable: 'channel_messages',
        targetId: channelMessageId,
      });
    },
  };
}

/**
 * The two audit actions the turn ledger reads back. DATA values, like
 * {@link SMOKE_ALARM_ACTION}: they are what a PIPEDA access request renders and what the
 * re-drive gate reads, so they are never renamed with the code.
 */
export const TURN_ANSWERED_ACTION = 'sms_turn_answered';
export const TURN_DEFERRED_ACTION = 'sms_turn_deferred';

/** The table both rows point at, named ONCE. The reader's predicate and the writers'
 * values are the same three strings; a fourth copy of any of them is how a gate stops
 * matching the rows it is supposed to find. */
const TURN_LEDGER_TARGET = 'channel_messages';

/**
 * How far back the stage read looks.
 *
 * The ONLY index on audit_log is (family_id, occurred_at), and this read now runs on
 * every inbound text rather than only on a failed turn during an outage. Bounding the
 * time makes it a range scan over one family's recent rows instead of a filter over
 * their whole history.
 *
 * A week is far past the point where the answer could change: pg-boss exhausts this
 * queue's retries in one to two hours (channel/config.ts), so a turn older than that is
 * not going to be re-driven at all.
 */
const TURN_LEDGER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The router's memory of its own attempts, in audit_log — no new table and no migration,
 * for the reason the alarm's claim gives: rule #6 already requires an immutable row for
 * what Hale did, so the row that RECORDS the decision is the row that stops it being
 * taken twice.
 *
 * ONE read answers the whole question. `answered` wins over `deferred` whatever order
 * the rows landed in, because a turn that was deferred nine times and then answered is
 * answered — there is no path back.
 *
 * `familyId` leads the WHERE because it leads the only index this table has, and because
 * scoping every lookup to the family the job claims is the router's rule-#1 habit.
 */
export function auditTurnLedger(database: Database): InboundTurnLedger {
  const write = (actionTaken: string) => async (input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
  }) => {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken,
      targetTable: TURN_LEDGER_TARGET,
      targetId: input.channelMessageId,
    });
  };

  return {
    stageOf: async ({ familyId, channelMessageId }) => {
      const rows = await database
        .select({ actionTaken: schema.auditLog.actionTaken })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.familyId, familyId),
            gte(schema.auditLog.occurredAt, new Date(Date.now() - TURN_LEDGER_LOOKBACK_MS)),
            eq(schema.auditLog.targetTable, TURN_LEDGER_TARGET),
            eq(schema.auditLog.targetId, channelMessageId),
            inArray(schema.auditLog.actionTaken, [TURN_ANSWERED_ACTION, TURN_DEFERRED_ACTION]),
          ),
        );
      if (rows.some((row) => row.actionTaken === TURN_ANSWERED_ACTION)) return 'answered';
      return rows.length > 0 ? 'deferred' : 'fresh';
    },
    recordAnswered: write(TURN_ANSWERED_ACTION),
    recordDeferred: write(TURN_DEFERRED_ACTION),
  };
}

export function channelRouterDeps(database: Database): ChannelRouterDeps {
  return {
    database,
    loadContext: loadInboundContext,
    transport: createTwilioTransport(),
    handlers: defaultHandlers(),
    offDomain: defaultOffDomainLane(database),
    smokeAlarm: auditSmokeAlarmClaim(database),
    turns: auditTurnLedger(database),
    // The words a broken turn gets, on the same lazy client the screen and the general
    // answer use — one key, one failure story, resolved only by the turn that needs one.
    apology: createTurnApology(screenClient),
    // The C2 seam (VIL-221), now the real runtime. The stub it replaces is kept as the
    // documented fallback shape rather than deleted — see coach-runtime.ts.
    coach: productionChannelCoach(database),
    // The offer half of the full-plan arc. Bound here rather than inside the coach
    // runtime because the row is minted against the SENT message, and the router is the
    // only thing that knows which row that was.
    recordPlanOffer: (db, input) => recordPlanOffer(db, input, defaultPlanOfferPorts()),
    limiter: new PostgresRateLimiter(database),
    now: () => new Date(),
    log: console,
  };
}

/** The drain's handler: route one inbound text. */
export async function routeInboundChannelMessage(
  database: Database,
  job: ChannelMessageReceivedPayload,
): Promise<void> {
  await routeChannelMessage(channelRouterDeps(database), job);
}
