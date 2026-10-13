import { type Database, schema } from '@hale/db';
import { autonomyActedDedupeKey, autonomyArmedDedupeKey } from '@hale/worker/memory-writer';
import { and, desc, eq, isNotNull, lt, ne } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { deliverFamilyOutbound } from '~/lib/channel/linq/family-outbound';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveHoldReason,
  type ProactiveSendRequest,
  type ProactiveSendVerdict,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
  holdStatus,
} from '~/lib/channel/outbound-gate';
import { readSendRefusal } from '~/lib/channel/outbound-transport';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import {
  type AutonomyNoticeContext,
  type AutonomyNoticeSkip,
  type AutonomyNoticeText,
  actedNoticeDetail,
  autonomyNoticeInput,
} from './notice-text';

/**
 * The text a parent gets when a kind turns on, turns back on, or Hale just did it
 * without asking.
 *
 * The model writes it. A skip, a dark household, or a quiet-hours hold sends
 * nothing and does not claim the dedupe key, so the sweep can try again. A send
 * that the provider refuses drops the key too: the obligation is "delivered", and
 * a failed row must not hold the kind forever with no retry.
 */

export const AUTONOMY_ARMED_TEMPLATE_KEY = 'autonomy:armed';
export const AUTONOMY_ACTED_TEMPLATE_KEY = 'autonomy:acted';

export type AutonomyNoticeOutcome =
  | 'sent'
  | 'dark'
  | 'already_sent'
  | 'lane_off'
  | 'no_send_target'
  | 'send_failed'
  | `compose_skipped:${AutonomyNoticeSkip}`
  | `gate_refused:${ProactiveHoldReason}`;

/** The same brake as the orchestrator: exact `=== 'true'`, no trim. */
export function autonomousLaneOn(): boolean {
  return process.env.AUTONOMOUS_EXECUTE_ENABLED === 'true';
}

export interface AutonomyNoticePorts {
  gate(request: ProactiveSendRequest): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  compose(input: AutonomyNoticeContext): Promise<AutonomyNoticeText>;
  transport: ChannelTransport;
  threadMessage: typeof threadProactiveMessage;
}

export function autonomyNoticeReaders(
  database: Database,
): Pick<AutonomyNoticePorts, 'gate' | 'resolvePhone'> {
  return {
    gate: (request) => assertProactiveSendAllowed(request, buildOutboundGatePorts(database)),
    resolvePhone: resolveSendablePhone,
  };
}

/** How many of the parent's own inbound texts the writer sees. Oldest first. */
const RECENT_INBOUND = 5;

/**
 * What the writer may use to pick a language. `localeHint` is the stored locale
 * and nothing else — a blank column is null, never a language this code chose.
 * `recentInbound` is the parent's own words.
 */
async function parentVoice(
  database: Database,
  userId: string,
): Promise<{ localeHint: string | null; recentInbound: string[] }> {
  const rows = await database
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const locale = rows[0]?.locale?.trim() ?? '';
  const inbound = await database
    .select({ body: schema.channelMessages.body })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, userId),
        eq(schema.channelMessages.direction, 'in'),
        isNotNull(schema.channelMessages.body),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(RECENT_INBOUND);
  const recentInbound = inbound
    .flatMap((row) => {
      const body = row.body?.trim() ?? '';
      return body.length > 0 ? [body] : [];
    })
    .reverse();
  return { localeHint: locale.length > 0 ? locale : null, recentInbound };
}

async function occasionForGrant(
  database: Database,
  input: { familyId: string; parentUserId: string; consentRecordId: string; actionType: string },
): Promise<'armed' | 'rearmed'> {
  const [current] = await database
    .select({ grantedAt: schema.consentRecords.grantedAt })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.id, input.consentRecordId))
    .limit(1);
  if (!current) return 'armed';
  // A later grant already on the ledger must not turn the first text into a re-arm.
  // Only a consent row from before this one means the kind had been on, then off.
  const prior = await database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, input.familyId),
        eq(schema.consentRecords.userId, input.parentUserId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.consentScope, input.actionType),
        ne(schema.consentRecords.id, input.consentRecordId),
        lt(schema.consentRecords.grantedAt, current.grantedAt),
      ),
    )
    .limit(1);
  return prior.length > 0 ? 'rearmed' : 'armed';
}

async function releaseClaim(database: Database, id: string, errorCode: string): Promise<void> {
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode, dedupeKey: null })
    .where(eq(schema.channelMessages.id, id));
}

/**
 * Send one notice. `kind` is the proactive class; `dedupeKey` is the obligation
 * (one per grant, or one per autonomous execution).
 */
async function sendAutonomyNotice(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    actionType: string;
    kind: 'autonomy_armed' | 'autonomy_acted';
    dedupeKey: string;
    templateKey: string;
    context: AutonomyNoticeContext;
    auditVerb: 'autonomy_armed_notice_sent' | 'autonomy_acted_notice_sent';
    now: Date;
  },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeOutcome> {
  const { familyId, parentUserId, now } = input;
  if (!autonomousLaneOn()) {
    console.info({ familyId, kind: input.kind }, 'autonomy notice: lane is off, text stays owed');
    return 'lane_off';
  }
  if (!f14EnabledFor(familyId)) {
    console.info({ familyId }, 'autonomy notice: household is dark, nothing sent');
    return 'dark';
  }
  if (await dedupeActive(input.dedupeKey, database)) return 'already_sent';

  const verdict = await ports.gate({ familyId, parentUserId, kind: input.kind, now });
  if (!verdict.allowed) {
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: input.kind,
      templateKey: input.templateKey,
      dedupeKey: null,
      status: holdStatus(verdict.reason),
    });
    console.warn(
      { familyId, reason: verdict.reason, kind: input.kind },
      'autonomy notice: held by the outbound gate',
    );
    return `gate_refused:${verdict.reason}`;
  }

  const written = await ports.compose(input.context);
  if ('skipped' in written) {
    console.warn(
      { familyId, skipped: written.skipped, kind: input.kind },
      'autonomy notice: model wrote nothing, send stays owed',
    );
    return `compose_skipped:${written.skipped}`;
  }

  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: input.kind,
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';

  const to = await ports.resolvePhone(database, parentUserId);
  if (to === null) {
    await releaseClaim(database, claimed.id, 'no_send_target');
    console.error(
      { familyId },
      'autonomy notice: the gate allowed a parent with no sendable number',
    );
    return 'no_send_target';
  }

  let providerMessageId: string;
  let carried: 'sms' | 'imessage' = 'sms';
  let chatId: string | null = null;
  try {
    const delivered = await deliverFamilyOutbound(database, {
      familyId,
      body: withOptOut(written.message, verdict.optOut),
      to,
      legacy: ports.transport,
      shareGroupCap: false,
    });
    if (delivered.status === 'held' || delivered.status === 'skipped') {
      const code = delivered.reason;
      await releaseClaim(database, claimed.id, code);
      console.warn({ familyId, code }, 'autonomy notice: outbound skipped');
      return 'send_failed';
    }
    providerMessageId = delivered.providerMessageId;
    carried = delivered.channel === 'imessage' ? 'imessage' : 'sms';
    chatId = delivered.chatId;
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await releaseClaim(database, claimed.id, code);
    console.error({ familyId, code }, 'autonomy notice: the provider refused the text');
    return 'send_failed';
  }

  await database
    .update(schema.channelMessages)
    .set({
      providerMessageId,
      channel: carried,
      providerChatId: chatId,
      status: acceptedStatus(carried),
    })
    .where(eq(schema.channelMessages.id, claimed.id));

  await ports.threadMessage(database, { familyId, parentUserId, body: written.message });
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: input.auditVerb,
    targetTable: 'channel_messages',
    targetId: claimed.id,
    after: {
      occasion: input.context.occasion,
      actionType: input.actionType,
      localeHint: input.context.localeHint,
    },
  });
  return 'sent';
}

/** Payload fields plus the decision reason. Null when the execution stored neither. */
async function executionDetail(database: Database, actionId: string): Promise<string | null> {
  const [action] = await database
    .select({ payload: schema.actions.payload })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);
  const [executed] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'action.executed'),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.targetId, actionId),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  const after = executed?.after as { decision?: { reason?: unknown } } | null;
  const reason = typeof after?.decision?.reason === 'string' ? after.decision.reason : null;
  return actedNoticeDetail({ payload: action?.payload ?? null, reason });
}

export async function tellParentKindArmed(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    consentRecordId: string;
    actionType: string;
    now: Date;
  },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeOutcome> {
  const occasion = await occasionForGrant(database, input);
  const voice = await parentVoice(database, input.parentUserId);
  return sendAutonomyNotice(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      actionType: input.actionType,
      kind: 'autonomy_armed',
      dedupeKey: autonomyArmedDedupeKey(input.consentRecordId),
      templateKey: AUTONOMY_ARMED_TEMPLATE_KEY,
      context: autonomyNoticeInput({
        occasion,
        actionType: input.actionType,
        ...voice,
        detail: null,
      }),
      auditVerb: 'autonomy_armed_notice_sent',
      now: input.now,
    },
    ports,
  );
}

export async function tellParentHaleActed(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    actionId: string;
    actionType: string;
    now: Date;
  },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeOutcome> {
  const voice = await parentVoice(database, input.parentUserId);
  const detail = await executionDetail(database, input.actionId);
  return sendAutonomyNotice(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      actionType: input.actionType,
      kind: 'autonomy_acted',
      dedupeKey: autonomyActedDedupeKey(input.actionId, input.parentUserId),
      templateKey: AUTONOMY_ACTED_TEMPLATE_KEY,
      context: autonomyNoticeInput({
        occasion: 'acted',
        actionType: input.actionType,
        ...voice,
        detail,
      }),
      auditVerb: 'autonomy_acted_notice_sent',
      now: input.now,
    },
    ports,
  );
}
