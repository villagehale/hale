import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { localCalendarDay } from '~/lib/channel/intake/cold-start/budget';
import { acceptedStatus } from '~/lib/channel/ledger';
import { isParentRole } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqFromE164, linqMultiFamilyGroupsEnabled } from './config';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * VIL-399 — a Linq group may hold more than one family, only after each
 * family has explicitly joined. Off unless `LINQ_MULTI_FAMILY_GROUPS_ENABLED`
 * is exactly `true`.
 *
 * A guess never merges two families. Being in the chat, or a parent of
 * another family adding a number, does not join anyone. The joining parent
 * has to be a parent of the family Hale already enrolled, and that join
 * writes that family's consent row.
 *
 * A shared reply is one of the placeholders below. It is not built from a
 * family's memory, calendar, email, children, or signups. Those stay on the
 * family that owns them. Ask budget and send caps are counted per family,
 * and sends also face one cap for the whole chat.
 */

/** DESIGN LOCK PENDING (Sloane). Placeholders until the lock. No opt-out line. */
export const MULTI_FAMILY_JOINED_TEXT = 'TODO-Design: this family is in the shared thread.';
export const MULTI_FAMILY_LEFT_TEXT = 'TODO-Design: this family has left the shared thread.';
export const MULTI_FAMILY_JOIN_NEEDED_TEXT =
  'TODO-Design: a family joins this thread by saying so.';
export const MULTI_FAMILY_SHARED_REPLY =
  'TODO-Design: replying from what this thread already said.';
export const MULTI_FAMILY_ASK_TEXT = 'TODO-Design: one question for this family.';

export const MULTI_FAMILY_PARENT_COPY = [
  MULTI_FAMILY_JOINED_TEXT,
  MULTI_FAMILY_LEFT_TEXT,
  MULTI_FAMILY_JOIN_NEEDED_TEXT,
  MULTI_FAMILY_SHARED_REPLY,
  MULTI_FAMILY_ASK_TEXT,
] as const;

const JOIN_TEMPLATE = 'linq:multi_family_joined';
const LEFT_TEMPLATE = 'linq:multi_family_left';
const JOIN_NEEDED_TEMPLATE = 'linq:multi_family_join_needed';
const REPLY_TEMPLATE = 'linq:multi_family_reply';
const ASK_TEMPLATE = 'linq:multi_family_ask';

/** Per family, inside one shared chat. */
export const MULTI_FAMILY_ASK_DAILY_MAX = 1;
export const MULTI_FAMILY_ASK_WINDOW_MAX = 4;
export const MULTI_FAMILY_ASK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MULTI_FAMILY_FAMILY_SEND_DAILY_MAX = 3;
/** Whole chat, so one busy family cannot spend every other family's room, and Hale stays bounded. */
export const MULTI_FAMILY_GROUP_SEND_DAILY_MAX = 6;

export const PRIVATE_FAMILY_SURFACES = [
  'memory',
  'calendar',
  'email',
  'children',
  'signups',
] as const;
export type PrivateFamilySurface = (typeof PRIVATE_FAMILY_SURFACES)[number];

export interface FamilyPrivateSlice {
  familyId: string;
  memory: string[];
  calendar: string[];
  email: string[];
  children: string[];
  signups: string[];
}

export type SharedGroupIntent = 'join' | 'leave' | 'none';

export function classifySharedGroupIntent(text: string): SharedGroupIntent {
  const normalized = text
    .trim()
    .replace(/[.!]+$/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (
    normalized === 'our family is in this group' ||
    normalized === 'notre famille est dans ce groupe'
  ) {
    return 'join';
  }
  if (
    normalized === 'our family is leaving this group' ||
    normalized === 'notre famille quitte ce groupe'
  ) {
    return 'leave';
  }
  return 'none';
}

/** The only strings a shared-group send may put on the phone. */
export function replyStaysInThread(text: string): boolean {
  return (MULTI_FAMILY_PARENT_COPY as readonly string[]).includes(text);
}

export interface SharedThreadContext {
  threadTexts: string[];
  memory: [];
  calendar: [];
  email: [];
  children: [];
  signups: [];
}

/** Thread utterances only. Private surfaces are empty on purpose. */
export function sharedThreadContext(threadTexts: readonly string[]): SharedThreadContext {
  return {
    threadTexts: threadTexts.map((text) => text.trim()).filter((text) => text.length > 0),
    memory: [],
    calendar: [],
    email: [],
    children: [],
    signups: [],
  };
}

export function emptyFamilySlice(familyId: string): FamilyPrivateSlice {
  return { familyId, memory: [], calendar: [], email: [], children: [], signups: [] };
}

export interface LedgerStamp {
  familyId: string;
  kind: 'ask' | 'send';
  createdAt: Date;
}

export function judgeFamilyAskBudget(
  input: {
    now: Date;
    rows: readonly LedgerStamp[];
    timeZone?: string;
  },
  familyId: string,
): { allow: true } | { allow: false; reason: 'ask_budget' } {
  const asks = input.rows.filter((row) => row.familyId === familyId && row.kind === 'ask');
  const day = localCalendarDay(input.now, input.timeZone);
  const today = asks.filter((row) => localCalendarDay(row.createdAt, input.timeZone) === day);
  if (today.length >= MULTI_FAMILY_ASK_DAILY_MAX) return { allow: false, reason: 'ask_budget' };
  const windowStart = input.now.getTime() - MULTI_FAMILY_ASK_WINDOW_MS;
  const inWindow = asks.filter((row) => row.createdAt.getTime() >= windowStart);
  if (inWindow.length >= MULTI_FAMILY_ASK_WINDOW_MAX) return { allow: false, reason: 'ask_budget' };
  return { allow: true };
}

export function judgeFamilySendCap(
  input: {
    now: Date;
    rows: readonly LedgerStamp[];
    timeZone?: string;
  },
  familyId: string,
): { allow: true } | { allow: false; reason: 'family_send_cap' | 'group_send_cap' } {
  const day = localCalendarDay(input.now, input.timeZone);
  const sendsToday = input.rows.filter(
    (row) => row.kind === 'send' && localCalendarDay(row.createdAt, input.timeZone) === day,
  );
  const familyToday = sendsToday.filter((row) => row.familyId === familyId);
  if (familyToday.length >= MULTI_FAMILY_FAMILY_SEND_DAILY_MAX) {
    return { allow: false, reason: 'family_send_cap' };
  }
  if (sendsToday.length >= MULTI_FAMILY_GROUP_SEND_DAILY_MAX) {
    return { allow: false, reason: 'group_send_cap' };
  }
  return { allow: true };
}

type SendGroup = (notice: { chatId: string; text: string }) => Promise<{
  providerMessageId: string;
}>;

type NoticeResult = 'sent' | 'already_sent' | 'not_sent' | 'refused_text' | 'no_parent';

function haleLine(phone: string): boolean {
  const from = linqFromE164();
  if (!from) return false;
  return normalizePhoneE164(from) === phone;
}

function seatablePhone(handle: string): string | null {
  const phone = normalizePhoneE164(handle);
  if (!phone || haleLine(phone)) return null;
  return phone;
}

async function familyRoleOf(
  database: Database,
  familyId: string,
  userId: string,
): Promise<string | null> {
  const rows = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return rows.find((row) => row.familyId === familyId && row.userId === userId)?.role ?? null;
}

async function primaryParentId(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return (
    rows.find((row) => row.familyId === familyId && row.role === 'primary_parent')?.userId ?? null
  );
}

async function liveJoins(database: Database, chatId: string) {
  const rows = await database
    .select({
      id: schema.linqMultiFamilyJoins.id,
      chatId: schema.linqMultiFamilyJoins.chatId,
      familyId: schema.linqMultiFamilyJoins.familyId,
      joinedByUserId: schema.linqMultiFamilyJoins.joinedByUserId,
      consentRecordId: schema.linqMultiFamilyJoins.consentRecordId,
      joinedAt: schema.linqMultiFamilyJoins.joinedAt,
      leftAt: schema.linqMultiFamilyJoins.leftAt,
    })
    .from(schema.linqMultiFamilyJoins);
  return rows.filter((row) => row.chatId === chatId && row.leftAt == null && row.joinedAt != null);
}

async function audit(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetTable: string;
    targetId: string;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: input.actionTaken,
    targetTable: input.targetTable,
    targetId: input.targetId,
    after: input.after,
  });
}

async function sendOnce(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    text: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    send?: SendGroup;
  },
): Promise<NoticeResult> {
  if (!replyStaysInThread(input.text)) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_data_refused',
      targetTable: 'channel_messages',
      targetId: input.familyId,
      after: { reason: 'text' },
    });
    console.warn(
      { familyId: input.familyId, outcome: 'refused_text' },
      'linq multi-family: the line was not a shared-thread placeholder',
    );
    return 'refused_text';
  }
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';
  try {
    const sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text })
      : await sendLinqChatMessage({ chatId: input.chatId, text: input.text });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn({ familyId: input.familyId, code }, 'linq multi-family: the line did not land');
    return 'not_sent';
  }
}

async function recordSend(
  database: Database,
  input: { chatId: string; familyId: string; now: Date },
): Promise<void> {
  await database.insert(schema.linqMultiFamilyLedger).values({
    chatId: input.chatId,
    familyId: input.familyId,
    kind: 'send',
    createdAt: input.now,
  });
}

async function ledgerStamps(database: Database, chatId: string): Promise<LedgerStamp[]> {
  const rows = await database
    .select({
      chatId: schema.linqMultiFamilyLedger.chatId,
      familyId: schema.linqMultiFamilyLedger.familyId,
      kind: schema.linqMultiFamilyLedger.kind,
      createdAt: schema.linqMultiFamilyLedger.createdAt,
    })
    .from(schema.linqMultiFamilyLedger);
  return rows
    .filter((row) => row.chatId === chatId && (row.kind === 'ask' || row.kind === 'send'))
    .map((row) => ({
      familyId: row.familyId,
      kind: row.kind as 'ask' | 'send',
      createdAt: row.createdAt,
    }));
}

async function cappedSend(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    parentUserId: string;
    text: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    send?: SendGroup;
  },
): Promise<NoticeResult | 'family_send_cap' | 'group_send_cap'> {
  const cap = judgeFamilySendCap(
    { now: input.now, rows: await ledgerStamps(database, input.chatId) },
    input.familyId,
  );
  if (!cap.allow) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_send_capped',
      targetTable: 'linq_multi_family_ledger',
      targetId: input.familyId,
      after: { reason: cap.reason },
    });
    console.info(
      { familyId: input.familyId, outcome: cap.reason },
      'linq multi-family: send cap held the line',
    );
    return cap.reason;
  }
  const notice = await sendOnce(database, input);
  if (notice === 'sent') await recordSend(database, input);
  return notice;
}

async function seatParent(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    userId: string;
    phone: string;
    role: 'parent' | 'co_parent';
    now: Date;
  },
): Promise<void> {
  const hash = phoneBlindIndex(input.phone);
  const rows = await database
    .select({
      id: schema.linqMultiFamilyMembers.id,
      chatId: schema.linqMultiFamilyMembers.chatId,
      phoneE164Hash: schema.linqMultiFamilyMembers.phoneE164Hash,
      removedAt: schema.linqMultiFamilyMembers.removedAt,
    })
    .from(schema.linqMultiFamilyMembers);
  const live = rows.find(
    (row) => row.chatId === input.chatId && row.phoneE164Hash === hash && row.removedAt == null,
  );
  if (live) return;
  await database.insert(schema.linqMultiFamilyMembers).values({
    chatId: input.chatId,
    familyId: input.familyId,
    userId: input.userId,
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: hash,
    role: input.role,
    seatedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function recordInbound(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    chatId: string;
    providerMessageId: string;
    text: string;
    receivedAt: Date;
    now: Date;
  },
): Promise<string | null> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: input.providerMessageId,
      providerChatId: input.chatId,
      status: 'delivered',
      body: input.text,
      sentAt: input.receivedAt,
      handedOffAt: input.now,
    })
    .onConflictDoNothing({
      target: schema.channelMessages.providerMessageId,
      where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  const id = row?.id;
  if (!id) return null;
  await audit(database, {
    familyId: input.familyId,
    actor: input.userId,
    actionTaken: 'sms_reply_received',
    targetTable: 'channel_messages',
    targetId: id,
  });
  return id;
}

export async function joinFamilyToSharedGroup(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    userId: string;
    phone: string;
    verbatim: string;
    now: Date;
    send?: SendGroup;
  },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'not_a_parent' }
  | { outcome: 'already_joined' }
  | { outcome: 'joined'; notice: NoticeResult }
> {
  if (!linqMultiFamilyGroupsEnabled()) return { outcome: 'flag_off' };
  const role = await familyRoleOf(database, input.familyId, input.userId);
  if (!role || !isParentRole(role)) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'linq_multi_family_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: input.familyId,
      after: { reason: 'not_a_parent' },
    });
    return { outcome: 'not_a_parent' };
  }
  const existing = (await liveJoins(database, input.chatId)).find(
    (row) => row.familyId === input.familyId,
  );
  if (existing) return { outcome: 'already_joined' };

  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: input.userId,
        familyId: input.familyId,
        consentType: 'multi_family_group',
        granted: true,
        consentScope: input.chatId,
        policyVersion: POLICY_VERSION,
        evidence: {
          verbatim: input.verbatim,
          interpretation: 'this parent joined their own family to this shared group',
          channel: 'imessage',
        },
      })
      .returning({ id: schema.consentRecords.id });
    if (!consent) throw new Error('linq multi-family: consent insert returned no row');
    const [join] = await tx
      .insert(schema.linqMultiFamilyJoins)
      .values({
        chatId: input.chatId,
        familyId: input.familyId,
        joinedByUserId: input.userId,
        consentRecordId: consent.id,
        joinedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: schema.linqMultiFamilyJoins.id });
    if (!join) throw new Error('linq multi-family: join insert returned no row');
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'linq_multi_family_joined',
      targetTable: 'linq_multi_family_joins',
      targetId: join.id,
      after: { chat: true },
    });
  });

  await seatParent(database, {
    chatId: input.chatId,
    familyId: input.familyId,
    userId: input.userId,
    phone: input.phone,
    role: role === 'co_parent' ? 'co_parent' : 'parent',
    now: input.now,
  });

  const notice = await cappedSend(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: input.chatId,
    text: MULTI_FAMILY_JOINED_TEXT,
    templateKey: JOIN_TEMPLATE,
    dedupeKey: `${JOIN_TEMPLATE}:${input.chatId}:${input.familyId}`,
    now: input.now,
    send: input.send,
  });
  return { outcome: 'joined', notice };
}

export async function leaveFamilyFromSharedGroup(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    userId: string;
    verbatim: string;
    now: Date;
    send?: SendGroup;
  },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'not_a_parent' }
  | { outcome: 'not_joined' }
  | { outcome: 'left'; notice: NoticeResult }
> {
  if (!linqMultiFamilyGroupsEnabled()) return { outcome: 'flag_off' };
  const role = await familyRoleOf(database, input.familyId, input.userId);
  if (!role || !isParentRole(role)) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'linq_multi_family_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: input.familyId,
      after: { reason: 'not_a_parent' },
    });
    return { outcome: 'not_a_parent' };
  }
  const join = (await liveJoins(database, input.chatId)).find(
    (row) => row.familyId === input.familyId,
  );
  if (!join) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'linq_multi_family_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: input.familyId,
      after: { reason: 'not_joined' },
    });
    return { outcome: 'not_joined' };
  }

  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .update(schema.linqMultiFamilyJoins)
      .set({ leftAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.linqMultiFamilyJoins.id, join.id),
          isNull(schema.linqMultiFamilyJoins.leftAt),
        ),
      );
    await tx
      .update(schema.linqMultiFamilyMembers)
      .set({ removedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.linqMultiFamilyMembers.chatId, input.chatId),
          eq(schema.linqMultiFamilyMembers.familyId, input.familyId),
          isNull(schema.linqMultiFamilyMembers.removedAt),
        ),
      );
    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'multi_family_group',
      granted: false,
      consentScope: input.chatId,
      policyVersion: POLICY_VERSION,
      evidence: {
        verbatim: input.verbatim,
        interpretation: 'this parent removed their own family from this shared group',
        channel: 'imessage',
      },
    });
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'linq_multi_family_left',
      targetTable: 'linq_multi_family_joins',
      targetId: join.id,
    });
  });

  const notice = await cappedSend(database, {
    familyId: input.familyId,
    parentUserId: input.userId,
    chatId: input.chatId,
    text: MULTI_FAMILY_LEFT_TEXT,
    templateKey: LEFT_TEMPLATE,
    dedupeKey: `${LEFT_TEMPLATE}:${input.chatId}:${input.familyId}:${input.now.toISOString()}`,
    now: input.now,
    send: input.send,
  });
  return { outcome: 'left', notice };
}

/** Unseat one person Linq removed. The family's join stays until a parent leaves. */
export async function unseatMultiFamilyMember(
  database: Database,
  input: { chatId: string; participantHandle: string; now: Date },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'ignored' }
  | { outcome: 'linq_multi_family_unseated' }
  | { outcome: 'absent' }
> {
  if (!linqMultiFamilyGroupsEnabled()) return { outcome: 'flag_off' };
  const phone = seatablePhone(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  const hash = phoneBlindIndex(phone);
  const rows = await database
    .select({
      id: schema.linqMultiFamilyMembers.id,
      chatId: schema.linqMultiFamilyMembers.chatId,
      familyId: schema.linqMultiFamilyMembers.familyId,
      phoneE164Hash: schema.linqMultiFamilyMembers.phoneE164Hash,
      removedAt: schema.linqMultiFamilyMembers.removedAt,
    })
    .from(schema.linqMultiFamilyMembers);
  const live = rows.find(
    (row) => row.chatId === input.chatId && row.phoneE164Hash === hash && row.removedAt == null,
  );
  if (!live) return { outcome: 'absent' };
  await database
    .update(schema.linqMultiFamilyMembers)
    .set({ removedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(schema.linqMultiFamilyMembers.id, live.id),
        isNull(schema.linqMultiFamilyMembers.removedAt),
      ),
    );
  await audit(database, {
    familyId: live.familyId,
    actor: 'system',
    actionTaken: 'linq_multi_family_unseated',
    targetTable: 'linq_multi_family_members',
    targetId: live.id,
  });
  return { outcome: 'linq_multi_family_unseated' };
}

/**
 * Private surfaces for one audience. The shared thread always gets an empty
 * slice, and the read does not touch the family's tables. Another family
 * gets an empty slice the same way. The owning family gets its rows only
 * when its live join has a granted consent record.
 */
export async function readFamilySliceForAudience(
  database: Database,
  input: { chatId: string; dataFamilyId: string; audience: string },
): Promise<{
  reason: 'shared_thread' | 'other_family' | 'no_consent' | 'consented';
  slice: FamilyPrivateSlice;
}> {
  const empty = emptyFamilySlice(input.dataFamilyId);
  if (input.audience === 'shared_thread') return { reason: 'shared_thread', slice: empty };
  if (input.audience !== input.dataFamilyId) return { reason: 'other_family', slice: empty };

  const join = (await liveJoins(database, input.chatId)).find(
    (row) => row.familyId === input.dataFamilyId && row.consentRecordId,
  );
  if (!join?.consentRecordId) {
    await audit(database, {
      familyId: input.dataFamilyId,
      actor: 'system',
      actionTaken: 'linq_multi_family_data_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: input.dataFamilyId,
      after: { reason: 'no_consent' },
    });
    return { reason: 'no_consent', slice: empty };
  }
  const [consent] = await database
    .select({
      id: schema.consentRecords.id,
      familyId: schema.consentRecords.familyId,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
      consentType: schema.consentRecords.consentType,
      consentScope: schema.consentRecords.consentScope,
    })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.id, join.consentRecordId));
  const allowed =
    consent &&
    consent.familyId === input.dataFamilyId &&
    consent.granted === true &&
    consent.revokedAt == null &&
    consent.consentType === 'multi_family_group' &&
    consent.consentScope === input.chatId;
  if (!allowed) {
    await audit(database, {
      familyId: input.dataFamilyId,
      actor: 'system',
      actionTaken: 'linq_multi_family_data_refused',
      targetTable: 'consent_records',
      targetId: join.consentRecordId,
      after: { reason: 'no_consent' },
    });
    return { reason: 'no_consent', slice: empty };
  }

  const [kids, facts, events, mail, bookings] = await Promise.all([
    database
      .select({ familyId: schema.children.familyId, name: schema.children.name })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.dataFamilyId)),
    database
      .select({
        familyId: schema.familyMemoryFacts.familyId,
        factKey: schema.familyMemoryFacts.factKey,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, input.dataFamilyId)),
    database
      .select({ familyId: schema.familyEvents.familyId, title: schema.familyEvents.title })
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, input.dataFamilyId)),
    database
      .select({
        familyId: schema.emailForwardsPending.familyId,
        subject: schema.emailForwardsPending.subject,
      })
      .from(schema.emailForwardsPending)
      .where(eq(schema.emailForwardsPending.familyId, input.dataFamilyId)),
    database
      .select({
        familyId: schema.activityBookings.familyId,
        title: schema.activityBookings.title,
      })
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, input.dataFamilyId)),
  ]);

  return {
    reason: 'consented',
    slice: {
      familyId: input.dataFamilyId,
      children: kids.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.name),
      memory: facts.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.factKey),
      calendar: events.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.title),
      email: mail.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.subject),
      signups: bookings
        .filter((row) => row.familyId === input.dataFamilyId)
        .map((row) => row.title),
    },
  };
}

export async function spendSharedGroupAsk(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    parentUserId: string;
    now: Date;
    send?: SendGroup;
    timeZone?: string;
  },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'not_joined' }
  | { outcome: 'ask_budget' }
  | { outcome: 'family_send_cap' | 'group_send_cap' }
  | { outcome: 'asked'; notice: NoticeResult }
> {
  if (!linqMultiFamilyGroupsEnabled()) return { outcome: 'flag_off' };
  const joined = (await liveJoins(database, input.chatId)).some(
    (row) => row.familyId === input.familyId && row.consentRecordId,
  );
  if (!joined) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_data_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: input.familyId,
      after: { reason: 'not_joined' },
    });
    return { outcome: 'not_joined' };
  }
  const rows = await ledgerStamps(database, input.chatId);
  const ask = judgeFamilyAskBudget(
    { now: input.now, rows, timeZone: input.timeZone },
    input.familyId,
  );
  if (!ask.allow) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_ask_capped',
      targetTable: 'linq_multi_family_ledger',
      targetId: input.familyId,
      after: { reason: 'ask_budget' },
    });
    console.info(
      { familyId: input.familyId, outcome: 'ask_budget' },
      'linq multi-family: ask budget held the question',
    );
    return { outcome: 'ask_budget' };
  }
  const notice = await cappedSend(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text: MULTI_FAMILY_ASK_TEXT,
    templateKey: ASK_TEMPLATE,
    dedupeKey: `${ASK_TEMPLATE}:${input.chatId}:${input.familyId}:${input.now.toISOString()}`,
    now: input.now,
    send: input.send,
  });
  if (notice === 'family_send_cap' || notice === 'group_send_cap') return { outcome: notice };
  if (notice === 'sent') {
    await database.insert(schema.linqMultiFamilyLedger).values({
      chatId: input.chatId,
      familyId: input.familyId,
      kind: 'ask',
      createdAt: input.now,
    });
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_ask_sent',
      targetTable: 'linq_multi_family_ledger',
      targetId: input.familyId,
    });
  }
  return { outcome: 'asked', notice };
}

export type MultiFamilyTurnResult =
  | { handled: false }
  | { handled: true; outcome: string; count: 'intake' | 'ignored' | 'duplicate'; notice?: string };

/**
 * Own the turn when this chat is a shared group, or when a parent is explicitly
 * joining or leaving. Otherwise return handled false so the household path
 * stays as it is. Does not call the household coach, and does not load
 * another family's private surfaces into the reply.
 */
export async function takeMultiFamilyTurn(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    text: string;
    providerMessageId: string;
    receivedAt: Date;
    now: Date;
    send?: SendGroup;
  },
): Promise<MultiFamilyTurnResult> {
  if (!linqMultiFamilyGroupsEnabled()) return { handled: false };
  const phone = seatablePhone(input.senderHandle);
  if (!phone) return { handled: false };

  const intent = classifySharedGroupIntent(input.text);
  const channel = await resolveVerifiedChannelByPhone(database, phone);
  const joins = await liveJoins(database, input.chatId);

  if (intent === 'join' || intent === 'leave') {
    if (!channel) {
      if (joins.length < 2) return { handled: false };
      return noticeUnenrolled(database, input, joins[0]?.familyId ?? null);
    }
    const role = await familyRoleOf(database, channel.familyId, channel.userId);
    if (!role || !isParentRole(role)) {
      await audit(database, {
        familyId: channel.familyId,
        actor: channel.userId,
        actionTaken: 'linq_multi_family_refused',
        targetTable: 'linq_multi_family_joins',
        targetId: channel.familyId,
        after: { reason: 'not_a_parent' },
      });
      return { handled: true, outcome: 'not_a_parent', count: 'ignored' };
    }
    const inbound = await recordInbound(database, {
      familyId: channel.familyId,
      userId: channel.userId,
      chatId: input.chatId,
      providerMessageId: input.providerMessageId,
      text: input.text,
      receivedAt: input.receivedAt,
      now: input.now,
    });
    if (!inbound) return { handled: true, outcome: 'duplicate', count: 'duplicate' };
    if (intent === 'join') {
      const joined = await joinFamilyToSharedGroup(database, {
        chatId: input.chatId,
        familyId: channel.familyId,
        userId: channel.userId,
        phone,
        verbatim: input.text,
        now: input.now,
        send: input.send,
      });
      return {
        handled: true,
        outcome: joined.outcome,
        count: joined.outcome === 'joined' ? 'intake' : 'ignored',
        notice: joined.outcome === 'joined' ? joined.notice : undefined,
      };
    }
    const left = await leaveFamilyFromSharedGroup(database, {
      chatId: input.chatId,
      familyId: channel.familyId,
      userId: channel.userId,
      verbatim: input.text,
      now: input.now,
      send: input.send,
    });
    return {
      handled: true,
      outcome: left.outcome,
      count: left.outcome === 'left' ? 'intake' : 'ignored',
      notice: left.outcome === 'left' ? left.notice : undefined,
    };
  }

  if (joins.length < 2) return { handled: false };

  if (!channel) return noticeUnenrolled(database, input, joins[0]?.familyId ?? null);

  const mine = joins.find((row) => row.familyId === channel.familyId);
  if (!mine) {
    const inbound = await recordInbound(database, {
      familyId: channel.familyId,
      userId: channel.userId,
      chatId: input.chatId,
      providerMessageId: input.providerMessageId,
      text: input.text,
      receivedAt: input.receivedAt,
      now: input.now,
    });
    if (!inbound) return { handled: true, outcome: 'duplicate', count: 'duplicate' };
    await audit(database, {
      familyId: channel.familyId,
      actor: channel.userId,
      actionTaken: 'linq_multi_family_refused',
      targetTable: 'linq_multi_family_joins',
      targetId: channel.familyId,
      after: { reason: 'family_not_joined' },
    });
    const host = joins[0];
    if (!host) return { handled: true, outcome: 'family_not_joined', count: 'ignored' };
    const parent = await primaryParentId(database, host.familyId);
    if (!parent) {
      console.warn(
        { familyId: host.familyId, outcome: 'no_primary_parent' },
        'linq multi-family: join-needed line was not ledgered',
      );
      return { handled: true, outcome: 'family_not_joined', count: 'ignored', notice: 'no_parent' };
    }
    const notice = await cappedSend(database, {
      familyId: host.familyId,
      parentUserId: parent,
      chatId: input.chatId,
      text: MULTI_FAMILY_JOIN_NEEDED_TEXT,
      templateKey: JOIN_NEEDED_TEMPLATE,
      dedupeKey: `${JOIN_NEEDED_TEMPLATE}:${input.chatId}:${phoneBlindIndex(phone)}`,
      now: input.now,
      send: input.send,
    });
    return { handled: true, outcome: 'family_not_joined', count: 'ignored', notice };
  }

  const inbound = await recordInbound(database, {
    familyId: channel.familyId,
    userId: channel.userId,
    chatId: input.chatId,
    providerMessageId: input.providerMessageId,
    text: input.text,
    receivedAt: input.receivedAt,
    now: input.now,
  });
  if (!inbound) return { handled: true, outcome: 'duplicate', count: 'duplicate' };

  const context = sharedThreadContext([input.text]);
  await audit(database, {
    familyId: channel.familyId,
    actor: channel.userId,
    actionTaken: 'linq_multi_family_private_withheld',
    targetTable: 'linq_multi_family_joins',
    targetId: mine.id,
    after: { surfaces: [...PRIVATE_FAMILY_SURFACES], threadUtterances: context.threadTexts.length },
  });
  const notice = await cappedSend(database, {
    familyId: channel.familyId,
    parentUserId: channel.userId,
    chatId: input.chatId,
    text: MULTI_FAMILY_SHARED_REPLY,
    templateKey: REPLY_TEMPLATE,
    dedupeKey: `${REPLY_TEMPLATE}:${input.chatId}:${input.providerMessageId}`,
    now: input.now,
    send: input.send,
  });
  if (notice === 'sent' || notice === 'already_sent') {
    await audit(database, {
      familyId: channel.familyId,
      actor: channel.userId,
      actionTaken: 'linq_multi_family_reply_sent',
      targetTable: 'channel_messages',
      targetId: inbound,
      after: { sources: 'thread' },
    });
  }
  const capped = notice === 'family_send_cap' || notice === 'group_send_cap';
  return {
    handled: true,
    outcome: capped ? notice : 'shared_reply',
    count: capped ? 'ignored' : 'intake',
    notice,
  };
}

async function noticeUnenrolled(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    now: Date;
    send?: SendGroup;
  },
  hostFamilyId: string | null,
): Promise<MultiFamilyTurnResult> {
  if (!hostFamilyId) return { handled: true, outcome: 'not_enrolled', count: 'ignored' };
  const parent = await primaryParentId(database, hostFamilyId);
  if (!parent) {
    console.warn(
      { familyId: hostFamilyId, outcome: 'no_primary_parent' },
      'linq multi-family: join-needed line was not ledgered',
    );
    return { handled: true, outcome: 'not_enrolled', count: 'ignored', notice: 'no_parent' };
  }
  const phone = seatablePhone(input.senderHandle);
  const notice = await cappedSend(database, {
    familyId: hostFamilyId,
    parentUserId: parent,
    chatId: input.chatId,
    text: MULTI_FAMILY_JOIN_NEEDED_TEXT,
    templateKey: JOIN_NEEDED_TEMPLATE,
    dedupeKey: `${JOIN_NEEDED_TEMPLATE}:${input.chatId}:${phone ? phoneBlindIndex(phone) : 'unknown'}`,
    now: input.now,
    send: input.send,
  });
  await audit(database, {
    familyId: hostFamilyId,
    actor: parent,
    actionTaken: 'linq_multi_family_refused',
    targetTable: 'linq_multi_family_joins',
    targetId: hostFamilyId,
    after: { reason: 'not_enrolled' },
  });
  return { handled: true, outcome: 'not_enrolled', count: 'ignored', notice };
}
