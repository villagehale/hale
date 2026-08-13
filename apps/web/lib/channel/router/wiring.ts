import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gte, isNull } from 'drizzle-orm';
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
import type { ApprovalSpine, PendingAction } from './approval';
import { defaultVillageIntroReplyDeps } from '~/lib/village/intros/reply';
import {
  approvalHandler,
  healthReplyHandler,
  sequenceReplyHandler,
  villageIntroHandler,
} from './handlers';
import {
  type ChannelRouterDeps,
  type DeterministicHandler,
  type InboundContext,
  realAckTimer,
  routeChannelMessage,
} from './route';
import type { SmokeAlarmClaim } from './smoke-alarm';

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
      return result.status === 202;
    },
    decline: async (database, args) => {
      const result = await declineDraftedAction(database, args);
      return result.status === 200;
    },
    undo: async (database, args) => {
      const result = await reverseExecutedCalendarAction(database, args);
      return result.status === 200;
    },
  };
}

/**
 * The handler chain, in the order it runs — narrow claimers before broad ones. See
 * handlers.ts for why "yes" resolves the way it does and why registration is last.
 */
export function defaultHandlers(): DeterministicHandler[] {
  return [
    villageIntroHandler(defaultVillageIntroReplyDeps()),
    approvalHandler(defaultApprovalSpine()),
    healthReplyHandler(defaultHealthReplyDeps()),
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
  screenAnthropic ??= new Anthropic({ apiKey });
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

export function channelRouterDeps(database: Database): ChannelRouterDeps {
  return {
    database,
    loadContext: loadInboundContext,
    transport: createTwilioTransport(),
    handlers: defaultHandlers(),
    offDomain: defaultOffDomainLane(database),
    smokeAlarm: auditSmokeAlarmClaim(database),
    // The C2 seam (VIL-221), now the real runtime. The stub it replaces is kept as the
    // documented fallback shape rather than deleted — see coach-runtime.ts.
    coach: productionChannelCoach(database),
    limiter: new PostgresRateLimiter(database),
    ackTimer: realAckTimer,
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
