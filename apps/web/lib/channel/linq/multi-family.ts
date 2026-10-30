import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { outboundLineFrom, sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import { isParentRole } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { DEFAULT_TIMEZONE, formatDateTime } from '~/lib/format/datetime';
import { isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import { linqMultiFamilyGroupsEnabled } from './config';
import { type PrivateAsideModel, type SendOneToOne, runPrivateAside } from './group-private-aside';
import type { ListChatHandles } from './roster';
import type { SharedGroupVoiceRequest } from './shared-group-line-input';
import type { SharedGroupReader, SharedGroupReading } from './shared-group-reading';
import { reactionAsVote, sharedGroupReader } from './shared-group-reading';
import type { SharedGroupComposer } from './shared-group-voice';
import { composeSharedGroupLine } from './shared-group-voice';
import { LinqSendError } from './transport';

/**
 * VIL-456 — Hale in an existing multi-family group.
 *
 * Off unless `LINQ_MULTI_FAMILY_GROUPS_ENABLED` is exactly `true`. A parent
 * adds Hale's number. Hale works from the first message: no join phrase, no
 * sign-up for anyone else. Known Hale numbers are linked to their own family.
 * A guess never merges two families. Anyone else takes part as a group member.
 * Each person can stop Hale for themselves, in any wording. Every parent-facing
 * line is model-written. The shared thread never reads a family's private
 * surfaces.
 */

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

export type SendGroup = (notice: { chatId: string; text: string }) => Promise<{
  providerMessageId: string;
}>;

export type NoticeResult =
  | 'sent'
  | 'already_sent'
  | 'declined'
  | 'not_sent'
  | 'refused_text'
  | 'no_parent';

export interface MultiFamilyTurnPorts {
  send?: SendGroup;
  listHandles?: ListChatHandles;
  reader?: SharedGroupReader;
  composer?: SharedGroupComposer;
  optOut?: (text: string) => Promise<'stop' | 'start' | 'none' | null>;
  language?: string;
}

const LEFT_TEMPLATE = 'linq:multi_family_left';
const REPLY_TEMPLATE = 'linq:multi_family_reply';
const ASK_TEMPLATE = 'linq:multi_family_ask';
const STOP_TEMPLATE = 'linq:multi_family_member_stop';
const INTRO_TEMPLATE = 'linq:multi_family_intro';
const WHO_TEMPLATE = 'linq:multi_family_who_confirmed';

function haleLine(phone: string): boolean {
  const from = outboundLineFrom();
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
  if (!input.text.trim()) {
    await audit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'linq_multi_family_data_refused',
      targetTable: 'channel_messages',
      targetId: input.familyId,
      after: { reason: 'empty' },
    });
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
      .set({ status: 'failed', errorCode: code, dedupeKey: null })
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

async function deliverShared(
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
): Promise<NoticeResult> {
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
    interpretation?: string;
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
          interpretation:
            input.interpretation ?? 'known Hale parent in this chat, linked by their number',
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
      after: { chat: true, linkedBy: 'known_number' },
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
  return { outcome: 'joined', notice: 'already_sent' };
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
  return { outcome: 'left', notice: 'already_sent' };
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

  // Consented path only: the owning family's live calendar rows, rendered as
  // clock-bearing strings ("Swim lesson · Nov 7, 10:00") in the family's zone so
  // the private aside can compare plan times (privateTimesOf). This list is read
  // for the family's own 1:1 aside and for the shared-thread deny list; a
  // shared-thread send never carries it (shared_thread / other_family above get
  // an empty slice before any table is touched).
  const [kids, facts, mail, bookings, events, zoneRows] = await Promise.all([
    database
      .select({
        id: schema.children.id,
        familyId: schema.children.familyId,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
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
    database
      .select({
        familyId: schema.familyEvents.familyId,
        title: schema.familyEvents.title,
        startsAt: schema.familyEvents.startsAt,
        childId: schema.familyEvents.childId,
        sensitive: schema.familyEvents.sensitive,
      })
      .from(schema.familyEvents)
      .where(and(eq(schema.familyEvents.familyId, input.dataFamilyId), householdFamilyEvent())),
    database
      .select({ timezone: schema.users.timezone })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
      .where(eq(schema.familyMembers.familyId, input.dataFamilyId))
      .limit(1),
  ]);
  const zone =
    zoneRows[0]?.timezone && zoneRows[0].timezone !== 'UTC'
      ? zoneRows[0].timezone
      : DEFAULT_TIMEZONE;

  return {
    reason: 'consented',
    slice: {
      familyId: input.dataFamilyId,
      children: kids.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.name),
      memory: facts.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.factKey),
      // A 13+ child's or sensitive row never enters the slice (isPrivateEvent), and
      // one parent's own Google mirror is excluded by the household-row predicate.
      calendar: events
        .filter((row) => row.familyId === input.dataFamilyId)
        .filter(
          (row) =>
            !isPrivateEvent({ childId: row.childId, sensitive: row.sensitive }, kids, new Date()),
        )
        .map((row) => `${row.title} · ${formatDateTime(row.startsAt, zone)}`),
      email: mail.filter((row) => row.familyId === input.dataFamilyId).map((row) => row.subject),
      signups: bookings
        .filter((row) => row.familyId === input.dataFamilyId)
        .map((row) => row.title),
    },
  };
}

async function denyListForChat(database: Database, chatId: string): Promise<string[]> {
  const joins = await liveJoins(database, chatId);
  const tokens: string[] = [];
  for (const join of joins) {
    const { slice } = await readFamilySliceForAudience(database, {
      chatId,
      dataFamilyId: join.familyId,
      audience: join.familyId,
    });
    tokens.push(...slice.children, ...slice.memory, ...slice.email, ...slice.signups);
    // Calendar titles block leaks too; the clock suffix is not a deny token.
    tokens.push(...slice.calendar.map((entry) => entry.split(' · ')[0] ?? ''));
  }
  return tokens.filter((token) => token.trim().length >= 3);
}

type PersonRow = typeof schema.linqSharedGroupPeople.$inferSelect;

async function peopleInChat(database: Database, chatId: string): Promise<PersonRow[]> {
  const rows = await database.select().from(schema.linqSharedGroupPeople);
  return rows.filter((row) => row.chatId === chatId);
}

async function rememberPerson(
  database: Database,
  input: {
    chatId: string;
    phone: string;
    familyId: string | null;
    userId: string | null;
    now: Date;
  },
): Promise<PersonRow> {
  const hash = phoneBlindIndex(input.phone);
  const existing = (await peopleInChat(database, input.chatId)).find(
    (row) => row.phoneE164Hash === hash,
  );
  if (existing) {
    // A known family is never moved onto another family. A later number match
    // may fill a null, and that is the first link, not a merge.
    if (existing.familyId || !input.familyId) return existing;
    const [updated] = await database
      .update(schema.linqSharedGroupPeople)
      .set({
        familyId: input.familyId,
        userId: input.userId ?? existing.userId,
        updatedAt: input.now,
      })
      .where(eq(schema.linqSharedGroupPeople.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [inserted] = await database
    .insert(schema.linqSharedGroupPeople)
    .values({
      chatId: input.chatId,
      phoneE164Encrypted: encryptString(input.phone),
      phoneE164Hash: hash,
      familyId: input.familyId,
      userId: input.userId,
      seatedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const again = (await peopleInChat(database, input.chatId)).find(
    (row) => row.phoneE164Hash === hash,
  );
  if (!again) throw new Error('linq multi-family: person insert returned no row');
  return again;
}

async function rememberHandle(
  database: Database,
  input: { chatId: string; handle: string; now: Date },
): Promise<PersonRow | null> {
  const phone = seatablePhone(input.handle);
  if (!phone) return null;
  const channel = await resolveVerifiedChannelByPhone(database, phone);
  return rememberPerson(database, {
    chatId: input.chatId,
    phone,
    familyId: channel?.familyId ?? null,
    userId: channel?.userId ?? null,
    now: input.now,
  });
}

async function linkKnownFamilies(
  database: Database,
  input: { chatId: string; people: readonly PersonRow[]; verbatim: string; now: Date },
): Promise<void> {
  const seen = new Set<string>();
  for (const person of input.people) {
    if (!person.familyId || !person.userId || seen.has(person.familyId)) continue;
    seen.add(person.familyId);
    const parentPhone = await phoneForHash(database, person.phoneE164Hash);
    if (!parentPhone) continue;
    await joinFamilyToSharedGroup(database, {
      chatId: input.chatId,
      familyId: person.familyId,
      userId: person.userId,
      phone: parentPhone,
      verbatim: input.verbatim,
      now: input.now,
      interpretation: 'known Hale parent in this chat, linked by their number',
    });
  }
}

async function phoneForHash(database: Database, hash: string): Promise<string | null> {
  const rows = await database
    .select({
      phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted,
      phoneE164Hash: schema.parentChannels.phoneE164Hash,
    })
    .from(schema.parentChannels)
    .where(eq(schema.parentChannels.phoneE164Hash, hash));
  const row = rows[0];
  if (!row) return null;
  return decryptString(row.phoneE164Encrypted);
}

function distinctFamilies(people: readonly PersonRow[]): string[] {
  return [
    ...new Set(people.map((person) => person.familyId).filter((id): id is string => Boolean(id))),
  ];
}

async function speak(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    chatId: string;
    request: SharedGroupVoiceRequest;
    language: string;
    parentWords: string | null;
    threadTexts: readonly string[];
    templateKey: string;
    dedupeKey: string;
    now: Date;
    ports: MultiFamilyTurnPorts;
  },
): Promise<NoticeResult> {
  const deny = await denyListForChat(database, input.chatId);
  const spoken = await composeSharedGroupLine(database, {
    familyId: input.familyId,
    request: input.request,
    language: input.language,
    parentWords: input.parentWords,
    threadSaid: input.threadTexts.map((text) => ({ speaker: null, text })),
    deny,
    voice: input.ports.composer,
  });
  if (!spoken.send) return spoken.fallback === 'declined' ? 'declined' : 'refused_text';
  return deliverShared(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    text: spoken.body,
    templateKey: input.templateKey,
    dedupeKey: input.dedupeKey,
    now: input.now,
    send: input.ports.send,
  });
}

async function hostLedger(
  database: Database,
  chatId: string,
  fallbackFamilyId: string | null,
): Promise<{ familyId: string; parentUserId: string } | null> {
  const joins = await liveJoins(database, chatId);
  const familyId = joins[0]?.familyId ?? fallbackFamilyId;
  if (!familyId) return null;
  const parentUserId = joins[0]?.joinedByUserId ?? (await primaryParentId(database, familyId));
  if (!parentUserId) return null;
  return { familyId, parentUserId };
}

export type MultiFamilyTurnResult =
  | { handled: false }
  | {
      handled: true;
      outcome: string;
      count: 'intake' | 'ignored' | 'duplicate';
      notice?: string;
      /** VIL-457: what the private aside did for this message, when it ran. */
      aside?: string;
    };

/**
 * The private aside never touches the group send: it only reads each family's own
 * consented slice and texts that family 1:1. A throw is logged and never fails the turn.
 */
async function privateAsideFor(
  database: Database,
  deps: { model: PrivateAsideModel; sendOneToOne: SendOneToOne },
  input: { chatId: string; inboundId: string; text: string; senderFamilyId: string },
): Promise<string> {
  try {
    const out = await runPrivateAside(database, deps, {
      ...input,
      recent: [{ from: 'member', text: input.text }],
      language: null,
    });
    return out.outcome;
  } catch (err) {
    console.warn(
      { chatId: input.chatId, err: err instanceof Error ? err.name : 'unknown' },
      'linq multi-family: private aside failed',
    );
    return 'error';
  }
}

/**
 * Own the turn when this chat holds more than one known family, or when Hale
 * can already see that from the participant list. Otherwise return handled
 * false so the household path stays as it is. Does not call the household
 * coach, and does not load another family's private surfaces into the reply.
 */
export async function takeMultiFamilyTurn(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    /**
     * Other participants the webhook itself listed (`chat.handles`). Seated before the
     * families gate so a first message can see a second family without a Linq API read.
     */
    otherHandles?: readonly string[];
    text: string;
    providerMessageId: string;
    receivedAt: Date;
    now: Date;
    send?: SendGroup;
    reactionType?: string | null;
    targetIsHale?: boolean;
    /**
     * VIL-457: after the group line, families whose own private facts the message touches
     * get one model-written 1:1 text each. Absent means no aside runs.
     */
    privateAside?: { model: PrivateAsideModel; sendOneToOne: SendOneToOne };
  },
  ports: MultiFamilyTurnPorts = {},
): Promise<MultiFamilyTurnResult> {
  if (!linqMultiFamilyGroupsEnabled()) return { handled: false };
  const phone = seatablePhone(input.senderHandle);
  if (!phone) return { handled: false };

  const wired: MultiFamilyTurnPorts = { ...ports, send: ports.send ?? input.send };
  const sender = await rememberHandle(database, {
    chatId: input.chatId,
    handle: input.senderHandle,
    now: input.now,
  });
  if (!sender) return { handled: false };

  for (const handle of new Set(input.otherHandles ?? [])) {
    if (handle === input.senderHandle || !seatablePhone(handle)) continue;
    await rememberHandle(database, { chatId: input.chatId, handle, now: input.now });
  }

  if (wired.listHandles) {
    const listed = await wired.listHandles({ chatId: input.chatId });
    if (listed.status === 'ok') {
      for (const handle of listed.handles) {
        await rememberHandle(database, { chatId: input.chatId, handle, now: input.now });
      }
    }
  }

  const people = await peopleInChat(database, input.chatId);
  const families = distinctFamilies(people);
  const joins = await liveJoins(database, input.chatId);
  if (families.length < 2 && joins.length < 2) return { handled: false };

  await linkKnownFamilies(database, {
    chatId: input.chatId,
    people,
    verbatim: input.text || 'known number in this chat',
    now: input.now,
  });

  const live = await peopleInChat(database, input.chatId);
  const me = live.find((row) => row.phoneE164Hash === sender.phoneE164Hash) ?? sender;
  const channel = me.familyId && me.userId ? { familyId: me.familyId, userId: me.userId } : null;
  const ledgerFamily = channel?.familyId ?? (await hostLedger(database, input.chatId, me.familyId));
  const familyId =
    typeof ledgerFamily === 'string' ? ledgerFamily : (ledgerFamily?.familyId ?? me.familyId);
  const userId =
    channel?.userId ??
    (typeof ledgerFamily === 'object' && ledgerFamily ? ledgerFamily.parentUserId : null);
  if (!familyId || !userId) {
    return { handled: true, outcome: 'no_host', count: 'ignored' };
  }

  if (me.stoppedAt && !input.reactionType) {
    const opt = wired.optOut ? await wired.optOut(input.text) : null;
    if (opt !== 'stop') {
      return { handled: true, outcome: 'member_stopped', count: 'ignored' };
    }
  }

  const inbound = channel
    ? await recordInbound(database, {
        familyId: channel.familyId,
        userId: channel.userId,
        chatId: input.chatId,
        providerMessageId: input.providerMessageId,
        text: input.text,
        receivedAt: input.receivedAt,
        now: input.now,
      })
    : 'guest';
  if (!inbound) return { handled: true, outcome: 'duplicate', count: 'duplicate' };

  const context = sharedThreadContext([input.text]);
  await audit(database, {
    familyId,
    actor: userId,
    actionTaken: 'linq_multi_family_private_withheld',
    targetTable: 'linq_shared_group_people',
    targetId: me.id,
    after: { surfaces: [...PRIVATE_FAMILY_SURFACES], threadUtterances: context.threadTexts.length },
  });

  const opt = wired.optOut ? await wired.optOut(input.text) : null;
  const reader = wired.reader ?? sharedGroupReader();
  const reaction = input.targetIsHale === false ? null : reactionAsVote(input.reactionType ?? null);
  const reading: SharedGroupReading = reader
    ? await reader.read({
        text: input.text,
        reaction,
        language: wired.language ?? null,
        people: live.map((row) => ({
          firstName: row.firstName,
          knownCustomer: Boolean(row.familyId),
          familyLinked: Boolean(row.familyId),
        })),
        recent: context.threadTexts.map((text) => ({ from: 'member' as const, text })),
      })
    : {
        intent:
          opt === 'stop'
            ? 'stop_me'
            : reaction === 'yes'
              ? 'yes'
              : reaction === 'no'
                ? 'no'
                : 'unclear',
        role: 'unclear',
        familyLabel: null,
        kidName: null,
        confidence: opt === 'stop' || reaction ? 'high' : 'low',
      };

  const intent = opt === 'stop' ? 'stop_me' : reading.intent;
  const language = wired.language ?? 'en';
  const host = (await hostLedger(database, input.chatId, familyId)) ?? {
    familyId,
    parentUserId: userId,
  };

  if (intent === 'stop_me') {
    await database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: input.now, updatedAt: input.now })
      .where(eq(schema.linqSharedGroupPeople.id, me.id));
    await unseatMultiFamilyMember(database, {
      chatId: input.chatId,
      participantHandle: input.senderHandle,
      now: input.now,
    });
    await audit(database, {
      familyId,
      actor: userId,
      actionTaken: 'linq_multi_family_member_stopped',
      targetTable: 'linq_shared_group_people',
      targetId: me.id,
      after: { only: 'this_member' },
    });
    const notice = await speak(database, {
      familyId: host.familyId,
      parentUserId: host.parentUserId,
      chatId: input.chatId,
      request: { kind: 'member_stop', name: me.firstName },
      language,
      parentWords: input.text,
      threadTexts: context.threadTexts,
      templateKey: STOP_TEMPLATE,
      dedupeKey: `${STOP_TEMPLATE}:${input.chatId}:${me.phoneE164Hash}`,
      now: input.now,
      ports: wired,
    });
    return { handled: true, outcome: 'member_stopped', count: 'intake', notice };
  }

  if (intent === 'leave' && channel) {
    const left = await leaveFamilyFromSharedGroup(database, {
      chatId: input.chatId,
      familyId: channel.familyId,
      userId: channel.userId,
      verbatim: input.text,
      now: input.now,
      send: wired.send,
    });
    if (left.outcome === 'left') {
      const notice = await speak(database, {
        familyId: host.familyId,
        parentUserId: host.parentUserId,
        chatId: input.chatId,
        request: { kind: 'family_left', leaverFirstName: me.firstName },
        language,
        parentWords: input.text,
        threadTexts: context.threadTexts,
        templateKey: LEFT_TEMPLATE,
        dedupeKey: `${LEFT_TEMPLATE}:${input.chatId}:${channel.familyId}:${input.now.toISOString()}`,
        now: input.now,
        ports: wired,
      });
      return { handled: true, outcome: 'left', count: 'intake', notice };
    }
    return { handled: true, outcome: left.outcome, count: 'ignored' };
  }

  if (intent === 'who_i_am' || intent === 'join') {
    await database
      .update(schema.linqSharedGroupPeople)
      .set({
        inferredRole: reading.role === 'unclear' ? me.inferredRole : reading.role,
        inferredFamilyLabel: reading.familyLabel ?? me.inferredFamilyLabel,
        inferredKidName: reading.kidName ?? me.inferredKidName,
        firstName: me.firstName,
        updatedAt: input.now,
      })
      .where(eq(schema.linqSharedGroupPeople.id, me.id));
    if (intent === 'who_i_am' && reading.role !== 'unclear') {
      const notice = await speak(database, {
        familyId: host.familyId,
        parentUserId: host.parentUserId,
        chatId: input.chatId,
        request: {
          kind: 'who_confirmed',
          name: me.firstName,
          roleWord: reading.role,
          kidFirstName: reading.kidName,
        },
        language,
        parentWords: input.text,
        threadTexts: context.threadTexts,
        templateKey: WHO_TEMPLATE,
        dedupeKey: `${WHO_TEMPLATE}:${input.chatId}:${me.phoneE164Hash}:${input.providerMessageId}`,
        now: input.now,
        ports: wired,
      });
      return { handled: true, outcome: 'who_confirmed', count: 'intake', notice };
    }
    return { handled: true, outcome: 'linked', count: 'intake' };
  }

  // VIL-496: past the two-family gate, a message that touches a family's own facts gets
  // its 1:1 aside whatever the group read was (question, chatter, unclear).
  const runAside = async (): Promise<string | undefined> =>
    input.privateAside && channel && inbound !== 'guest'
      ? await privateAsideFor(database, input.privateAside, {
          chatId: input.chatId,
          inboundId: inbound,
          text: input.text,
          senderFamilyId: channel.familyId,
        })
      : undefined;
  const logFallthrough = (why: string, aside: string | undefined) => {
    console.info('linq multi-family: turn handed back', {
      chatId: input.chatId,
      intent: why,
      aside: aside ?? (input.privateAside ? (channel ? 'guest' : 'no_channel') : 'not_wired'),
    });
  };

  if (intent === 'question' || intent === 'yes' || intent === 'no') {
    const notice = await speak(database, {
      familyId: host.familyId,
      parentUserId: host.parentUserId,
      chatId: input.chatId,
      request: { kind: 'answer', lookup: null },
      language,
      parentWords: input.text,
      threadTexts: context.threadTexts,
      templateKey: REPLY_TEMPLATE,
      dedupeKey: `${REPLY_TEMPLATE}:${input.chatId}:${input.providerMessageId}`,
      now: input.now,
      ports: wired,
    });
    const groupSpoke = notice === 'sent' || notice === 'already_sent';
    if (groupSpoke) {
      await audit(database, {
        familyId,
        actor: userId,
        actionTaken: 'linq_multi_family_reply_sent',
        targetTable: 'channel_messages',
        targetId: inbound === 'guest' ? me.id : inbound,
        after: { sources: 'thread', intent },
      });
    }
    // VIL-496 (Design lock): the private aside never waits on the group line. A family
    // whose own facts the message touches hears 1:1 even when Hale stays quiet here.
    const aside = await runAside();
    if (!groupSpoke) {
      // Quiet group + an aside that ran: Hale owned this turn, so it must not fall
      // through to the mixed-family hold. With no aside, hand it back so the rest of
      // the group door (text RSVP for a plan) still reads it.
      if (aside === 'ran') {
        return { handled: true, outcome: 'aside_only', count: 'intake', notice, aside };
      }
      logFallthrough(intent, aside);
      return { handled: false };
    }
    return {
      handled: true,
      outcome: intent === 'question' ? 'shared_reply' : intent,
      count: 'intake',
      notice,
      ...(aside ? { aside } : {}),
    };
  }

  // Chatter and an unclear read are not Hale's group turn, but a private fact in them
  // still earns its 1:1 aside. Without one, hand the message back so the rest of the
  // group door (text RSVP for a plan) still reads it.
  const aside = await runAside();
  if (aside === 'ran') {
    return { handled: true, outcome: 'aside_only', count: 'intake', aside };
  }
  logFallthrough(intent, aside);
  return { handled: false };
}

/** Hale was just added. One who's-who, then quiet until someone answers or asks. */
export async function noticeSharedGroupAdded(
  database: Database,
  input: {
    chatId: string;
    adderHandle: string | null;
    now: Date;
    handles?: readonly string[];
  },
  ports: MultiFamilyTurnPorts = {},
): Promise<MultiFamilyTurnResult> {
  if (!linqMultiFamilyGroupsEnabled()) return { handled: false };
  const handles = [...(input.handles ?? []), ...(input.adderHandle ? [input.adderHandle] : [])];
  for (const handle of handles) {
    await rememberHandle(database, { chatId: input.chatId, handle, now: input.now });
  }
  if (ports.listHandles) {
    const listed = await ports.listHandles({ chatId: input.chatId });
    if (listed.status === 'ok') {
      for (const handle of listed.handles) {
        await rememberHandle(database, { chatId: input.chatId, handle, now: input.now });
      }
    }
  }
  const people = await peopleInChat(database, input.chatId);
  if (distinctFamilies(people).length < 2) return { handled: false };
  await linkKnownFamilies(database, {
    chatId: input.chatId,
    people,
    verbatim: 'Hale added to this chat',
    now: input.now,
  });
  const host = await hostLedger(
    database,
    input.chatId,
    people.find((row) => row.familyId)?.familyId ?? null,
  );
  if (!host) return { handled: true, outcome: 'no_host', count: 'ignored' };
  const adder = input.adderHandle
    ? await rememberHandle(database, {
        chatId: input.chatId,
        handle: input.adderHandle,
        now: input.now,
      })
    : null;
  const notice = await speak(database, {
    familyId: host.familyId,
    parentUserId: host.parentUserId,
    chatId: input.chatId,
    request: { kind: 'intro', adderFirstName: adder?.firstName ?? null },
    language: ports.language ?? 'en',
    parentWords: null,
    threadTexts: [],
    templateKey: INTRO_TEMPLATE,
    dedupeKey: `${INTRO_TEMPLATE}:${input.chatId}`,
    now: input.now,
    ports,
  });
  return {
    handled: true,
    outcome: 'intro',
    count: notice === 'sent' ? 'intake' : 'ignored',
    notice,
  };
}

export async function takeMultiFamilyReaction(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    reactionType: string | null;
    providerMessageId: string;
    now: Date;
    targetIsHale?: boolean;
  },
  ports: MultiFamilyTurnPorts = {},
): Promise<MultiFamilyTurnResult> {
  const vote = reactionAsVote(input.reactionType);
  if (!vote) return { handled: false };
  return takeMultiFamilyTurn(
    database,
    {
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      text: '',
      providerMessageId: input.providerMessageId,
      receivedAt: input.now,
      now: input.now,
      reactionType: input.reactionType,
      targetIsHale: input.targetIsHale ?? true,
    },
    ports,
  );
}

export async function spendSharedGroupAsk(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    parentUserId: string;
    now: Date;
    send?: SendGroup;
    composer?: SharedGroupComposer;
    askeeFirstName?: string;
    about?: string;
    language?: string;
  },
): Promise<
  { outcome: 'flag_off' } | { outcome: 'not_joined' } | { outcome: 'asked'; notice: NoticeResult }
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
  const notice = await speak(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    chatId: input.chatId,
    request: {
      kind: 'family_ask',
      askeeFirstName: input.askeeFirstName ?? '',
      about: input.about ?? '',
    },
    language: input.language ?? 'en',
    parentWords: null,
    threadTexts: [],
    templateKey: ASK_TEMPLATE,
    dedupeKey: `${ASK_TEMPLATE}:${input.chatId}:${input.familyId}:${input.now.toISOString()}`,
    now: input.now,
    ports: { send: input.send, composer: input.composer },
  });
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
