import { type Database, schema } from '@hale/db';
import { autonomyActedDedupeKey, autonomyArmedDedupeKey } from '@hale/worker/memory-writer';
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
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
  type AutonomyNoticeItem,
  type AutonomyNoticeOccasion,
  type AutonomyNoticeSkip,
  type AutonomyNoticeText,
  actedNoticeDetail,
  noticeStanding,
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

async function releaseClaims(database: Database, ids: string[], errorCode: string): Promise<void> {
  if (ids.length === 0) return;
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode, dedupeKey: null })
    .where(inArray(schema.channelMessages.id, ids));
}

const NOTICE_CLAIM_VERBS = [
  'autonomy_notice_covered',
  'autonomy_notice_cover_released',
  'autonomy_armed_notice_sent',
  'autonomy_acted_notice_sent',
] as const;

/**
 * Keys already taken by a real send, or by a cover audit that a later release
 * has not cleared. A sent audit keeps the key even if a release was also written.
 */
export async function claimedAutonomyNoticeKeys(
  database: Database,
  keys: string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const channel = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.dedupeKey, keys));
  const claimed = new Set(channel.flatMap((row) => (row.dedupeKey ? [row.dedupeKey] : [])));
  const audits = await database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        inArray(schema.auditLog.actionTaken, [...NOTICE_CLAIM_VERBS]),
        inArray(sql`${schema.auditLog.after} ->> 'dedupeKey'`, keys),
      ),
    );
  const tally = new Map<string, { covers: number; releases: number; sent: boolean }>();
  for (const row of audits) {
    const after = row.after as { dedupeKey?: unknown } | null;
    const key = typeof after?.dedupeKey === 'string' ? after.dedupeKey : null;
    if (!key) continue;
    const slot = tally.get(key) ?? { covers: 0, releases: 0, sent: false };
    if (row.actionTaken === 'autonomy_notice_covered') slot.covers += 1;
    else if (row.actionTaken === 'autonomy_notice_cover_released') slot.releases += 1;
    else slot.sent = true;
    tally.set(key, slot);
  }
  for (const [key, slot] of tally) {
    if (slot.sent || slot.covers > slot.releases) claimed.add(key);
  }
  return claimed;
}

async function noticeKeyClaimed(database: Database, key: string): Promise<boolean> {
  const claimed = await claimedAutonomyNoticeKeys(database, [key]);
  return claimed.has(key);
}

async function coverAuxiliaryClaims(
  database: Database,
  input: { familyId: string; primaryId: string; claims: NoticeClaim[] },
): Promise<void> {
  for (const claim of input.claims) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'autonomy_notice_covered',
      targetTable: 'channel_messages',
      targetId: input.primaryId,
      after: {
        dedupeKey: claim.dedupeKey,
        occasion: claim.occasion,
        actionType: claim.actionType,
      },
    });
  }
}

async function releaseCoveredClaims(
  database: Database,
  input: { familyId: string; primaryId: string; claims: NoticeClaim[] },
): Promise<void> {
  for (const claim of input.claims) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'autonomy_notice_cover_released',
      targetTable: 'channel_messages',
      targetId: input.primaryId,
      after: {
        dedupeKey: claim.dedupeKey,
        occasion: claim.occasion,
        actionType: claim.actionType,
      },
    });
  }
}

interface NoticeClaim {
  dedupeKey: string;
  kind: 'autonomy_armed' | 'autonomy_acted';
  templateKey: string;
  auditVerb: 'autonomy_armed_notice_sent' | 'autonomy_acted_notice_sent';
  occasion: AutonomyNoticeOccasion;
  actionType: string;
}

interface BuiltNotice {
  claim: NoticeClaim;
  item: AutonomyNoticeItem;
}

/**
 * One text for this parent. The first claim is the only channel_messages row.
 * Each other claim is an audit row written before the provider call, so a later
 * pass does not send it again. A failed send releases those audits. The sent
 * audit, not a second queued text, is what marks a covered turn-on delivered.
 */
async function sendAutonomyNotice(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    context: AutonomyNoticeContext;
    claims: NoticeClaim[];
    now: Date;
  },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeOutcome> {
  const { familyId, parentUserId, now } = input;
  const [primary] = input.claims;
  if (!primary) return 'already_sent';
  if (!autonomousLaneOn()) {
    console.info({ familyId, kind: primary.kind }, 'autonomy notice: lane is off, text stays owed');
    return 'lane_off';
  }
  if (!f14EnabledFor(familyId)) {
    console.info({ familyId }, 'autonomy notice: household is dark, nothing sent');
    return 'dark';
  }
  if (await noticeKeyClaimed(database, primary.dedupeKey)) return 'already_sent';

  const verdict = await ports.gate({ familyId, parentUserId, kind: primary.kind, now });
  if (!verdict.allowed) {
    await database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: primary.kind,
      templateKey: primary.templateKey,
      dedupeKey: null,
      status: holdStatus(verdict.reason),
    });
    console.warn(
      { familyId, reason: verdict.reason, kind: primary.kind },
      'autonomy notice: held by the outbound gate',
    );
    return `gate_refused:${verdict.reason}`;
  }

  const written = await ports.compose(input.context);
  if ('skipped' in written) {
    console.warn(
      { familyId, skipped: written.skipped, kind: primary.kind },
      'autonomy notice: model wrote nothing, send stays owed',
    );
    return `compose_skipped:${written.skipped}`;
  }

  const auxiliary = input.claims.slice(1);
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: primary.kind,
      templateKey: primary.templateKey,
      dedupeKey: primary.dedupeKey,
      status: acceptedStatus('sms'),
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!row) return 'already_sent';
  const primaryId = row.id;
  await coverAuxiliaryClaims(database, { familyId, primaryId, claims: auxiliary });

  const to = await ports.resolvePhone(database, parentUserId);
  if (to === null) {
    await releaseClaims(database, [primaryId], 'no_send_target');
    await releaseCoveredClaims(database, { familyId, primaryId, claims: auxiliary });
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
      await releaseClaims(database, [primaryId], code);
      await releaseCoveredClaims(database, { familyId, primaryId, claims: auxiliary });
      console.warn({ familyId, code }, 'autonomy notice: outbound skipped');
      return 'send_failed';
    }
    providerMessageId = delivered.providerMessageId;
    carried = delivered.channel === 'imessage' ? 'imessage' : 'sms';
    chatId = delivered.chatId;
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    await releaseClaims(database, [primaryId], code);
    await releaseCoveredClaims(database, { familyId, primaryId, claims: auxiliary });
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
      errorCode: null,
    })
    .where(eq(schema.channelMessages.id, primaryId));

  await ports.threadMessage(database, { familyId, parentUserId, body: written.message });
  for (const claim of input.claims) {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: claim.auditVerb,
      targetTable: 'channel_messages',
      targetId: primaryId,
      after: {
        occasion: claim.occasion,
        actionType: claim.actionType,
        localeHint: input.context.localeHint,
        dedupeKey: claim.dedupeKey,
      },
    });
  }
  return 'sent';
}

/** Labelled payload fields, and the decision reason as `why`. */
async function executionDetail(
  database: Database,
  actionId: string,
): Promise<{ detail: AutonomyNoticeItem['detail']; why: string | null }> {
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

export type OpenAutonomyObligation =
  | { kind: 'armed'; consentRecordId: string; actionType: string }
  | { kind: 'acted'; actionId: string; actionType: string };

/**
 * One text that covers every notice this parent is still owed. A quiet-hours hold
 * claims nothing. A send claims every dedupe key.
 */
export async function tellParentOpenNotices(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    now: Date;
    notices: OpenAutonomyObligation[];
  },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeOutcome> {
  const voice = await parentVoice(database, input.parentUserId);
  const built: BuiltNotice[] = [];
  for (const notice of input.notices) {
    if (notice.kind === 'armed') {
      const occasion = await occasionForGrant(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        consentRecordId: notice.consentRecordId,
        actionType: notice.actionType,
      });
      const item: AutonomyNoticeItem = {
        occasion,
        actionType: notice.actionType,
        detail: null,
        why: null,
        standing: noticeStanding({ occasion, actionType: notice.actionType }),
      };
      if (await noticeKeyClaimed(database, autonomyArmedDedupeKey(notice.consentRecordId)))
        continue;
      built.push({
        item,
        claim: {
          dedupeKey: autonomyArmedDedupeKey(notice.consentRecordId),
          kind: 'autonomy_armed',
          templateKey: AUTONOMY_ARMED_TEMPLATE_KEY,
          auditVerb: 'autonomy_armed_notice_sent',
          occasion,
          actionType: notice.actionType,
        },
      });
      continue;
    }
    const parts = await executionDetail(database, notice.actionId);
    const item: AutonomyNoticeItem = {
      occasion: 'acted',
      actionType: notice.actionType,
      detail: parts.detail,
      why: parts.why,
      standing: noticeStanding({ occasion: 'acted', actionType: notice.actionType }),
    };
    const dedupeKey = autonomyActedDedupeKey(notice.actionId, input.parentUserId);
    if (await noticeKeyClaimed(database, dedupeKey)) continue;
    built.push({
      item,
      claim: {
        dedupeKey,
        kind: 'autonomy_acted',
        templateKey: AUTONOMY_ACTED_TEMPLATE_KEY,
        auditVerb: 'autonomy_acted_notice_sent',
        occasion: 'acted',
        actionType: notice.actionType,
      },
    });
  }
  const first = built[0];
  if (!first) return 'already_sent';
  const context: AutonomyNoticeContext = {
    occasion: first.item.occasion,
    actionType: first.item.actionType,
    localeHint: voice.localeHint,
    recentInbound: voice.recentInbound,
    detail: first.item.detail,
    why: first.item.why,
    standing: first.item.standing,
    ...(built.length > 1 ? { items: built.map((row) => row.item) } : {}),
  };
  return sendAutonomyNotice(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      context,
      claims: built.map((row) => row.claim),
      now: input.now,
    },
    ports,
  );
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
  return tellParentOpenNotices(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
      notices: [
        {
          kind: 'armed',
          consentRecordId: input.consentRecordId,
          actionType: input.actionType,
        },
      ],
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
  return tellParentOpenNotices(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
      notices: [{ kind: 'acted', actionId: input.actionId, actionType: input.actionType }],
    },
    ports,
  );
}
