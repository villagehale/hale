import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { isParentRole } from '~/lib/channel/role-scope';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqFromE164, linqGroupMembersEnabled } from './config';
import { LINQ_GROUP_UNKNOWN_HOLD } from './group';
import { LinqSendError, sendLinqChatMessage } from './transport';

type LinqGroupMemberRole = 'parent' | 'co_parent' | 'other_family' | 'caregiver';

/**
 * VIL-398 — seats in a claimed household Linq group.
 *
 * Off unless `LINQ_GROUP_MEMBERS_ENABLED` is exactly `true`. A parent add, or
 * Hale when Linq names no actor, seats the phone and sends one welcome. Hale
 * adding someone still seats them. A named stranger does not. Removal unseats.
 * A phone already in another family is refused. There is no member cap.
 */

/**
 * DESIGN LOCK PENDING (Sloane). One line when a newcomer is seated. The
 * placeholder is the copy until that lock; it must not grow an opt-out.
 */
export const LINQ_GROUP_MEMBER_WELCOME = 'TODO-Design: you are in this household thread.';

const WELCOME_TEMPLATE = 'linq:group_member_welcome';
const HOLD_TEMPLATE = 'linq:group_unknown_hold';

export type AddActorKind = 'parent' | 'unnamed' | 'hale' | 'other';

export function classifyParticipantAdd(input: {
  participantPhone: string;
  actorHandle: string | null;
  isFromMe: boolean;
  actorIsHouseholdParent: boolean;
  actorIsHale: boolean;
}): { kind: AddActorKind; seat: boolean; welcome: boolean } {
  const actorPhone = input.actorHandle ? normalizePhoneE164(input.actorHandle) : null;
  const unnamed = !actorPhone || actorPhone === input.participantPhone;
  if (unnamed) return { kind: 'unnamed', seat: true, welcome: true };
  if (input.actorIsHouseholdParent) return { kind: 'parent', seat: true, welcome: true };
  if (input.isFromMe || input.actorIsHale) return { kind: 'hale', seat: true, welcome: false };
  return { kind: 'other', seat: false, welcome: false };
}

export type SeatNotice = 'sent' | 'already_sent' | 'not_sent' | 'skipped' | 'no_primary_parent';

export type SeatParticipantResult =
  | { outcome: 'flag_off' }
  | { outcome: 'ignored' }
  | { outcome: 'group_unclaimed' }
  | { outcome: 'group_member_refused'; reason: 'other_family' | 'actor' | 'other_chat' }
  | { outcome: 'group_member_already' }
  | { outcome: 'group_member_seated'; role: LinqGroupMemberRole; notice: SeatNotice };

type SendGroup = (notice: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;

async function familyIdForChat(database: Database, chatId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return rows.find((row) => row.linqGroupChatId === chatId)?.id ?? null;
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
  return (
    rows.find((row) => row.familyId === familyId && row.userId === userId)?.role ?? null
  );
}

function groupRoleFor(familyRole: string | null, hasCoParent: boolean): LinqGroupMemberRole {
  if (familyRole === 'primary_parent') return 'parent';
  if (familyRole === 'co_parent') return 'co_parent';
  if (familyRole === 'nanny' || familyRole === 'babysitter' || familyRole === 'service') {
    return 'caregiver';
  }
  if (familyRole === 'grandparent' || familyRole === 'extended') return 'other_family';
  return hasCoParent ? 'other_family' : 'co_parent';
}

function familyRoleForSeat(role: LinqGroupMemberRole): 'co_parent' | 'extended' | 'service' | null {
  if (role === 'co_parent') return 'co_parent';
  if (role === 'other_family') return 'extended';
  if (role === 'caregiver') return 'service';
  return null;
}

async function familyHasCoParent(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ role: schema.familyMembers.role, familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  return rows.some((row) => row.familyId === familyId && row.role === 'co_parent');
}

async function liveSeats(database: Database) {
  return database
    .select({
      id: schema.linqGroupMembers.id,
      familyId: schema.linqGroupMembers.familyId,
      chatId: schema.linqGroupMembers.chatId,
      userId: schema.linqGroupMembers.userId,
      phoneE164Hash: schema.linqGroupMembers.phoneE164Hash,
      role: schema.linqGroupMembers.role,
      removedAt: schema.linqGroupMembers.removedAt,
      welcomedAt: schema.linqGroupMembers.welcomedAt,
    })
    .from(schema.linqGroupMembers);
}

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

async function actorIsHouseholdParent(
  database: Database,
  familyId: string,
  actorHandle: string | null,
): Promise<{ parent: boolean; userId: string | null }> {
  if (!actorHandle) return { parent: false, userId: null };
  const phone = normalizePhoneE164(actorHandle);
  if (!phone) return { parent: false, userId: null };
  const existing = await resolveVerifiedChannelByPhone(database, phone);
  if (!existing || existing.familyId !== familyId) return { parent: false, userId: null };
  const role = await familyRoleOf(database, familyId, existing.userId);
  if (role && isParentRole(role)) return { parent: true, userId: existing.userId };
  const hash = phoneBlindIndex(phone);
  const seats = await liveSeats(database);
  const seat = seats.find(
    (row) =>
      row.familyId === familyId &&
      row.phoneE164Hash === hash &&
      row.removedAt == null &&
      (row.role === 'parent' || row.role === 'co_parent'),
  );
  return seat ? { parent: true, userId: seat.userId } : { parent: false, userId: null };
}

async function provisionMember(
  database: Database,
  input: {
    familyId: string;
    phone: string;
    role: LinqGroupMemberRole;
    invitedByUserId: string | null;
    chatId: string;
    now: Date;
  },
): Promise<string> {
  const phoneHash = phoneBlindIndex(input.phone);
  const familyRole = familyRoleForSeat(input.role);
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .insert(schema.users)
      .values({ externalAuthId: `sms:${phoneHash}`, email: null, name: null })
      .onConflictDoNothing({ target: schema.users.externalAuthId });
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalAuthId, `sms:${phoneHash}`))
      .limit(1);
    if (!user) throw new Error('linq group member: users insert returned no row');

    if (familyRole) {
      await tx
        .insert(schema.familyMembers)
        .values({
          familyId: input.familyId,
          userId: user.id,
          role: familyRole,
          invitedByUserId: input.invitedByUserId,
        })
        .onConflictDoNothing();
    }

    if (input.role === 'co_parent') {
      await tx
        .insert(schema.loopPrefs)
        .values({ userId: user.id, loopChannel: 'sms' })
        .onConflictDoNothing({ target: schema.loopPrefs.userId });
      await tx.insert(schema.linqGroupOnboarding).values({
        familyId: input.familyId,
        userId: user.id,
        providerChatId: input.chatId,
        step: 'awaiting_name',
        createdAt: input.now,
        updatedAt: input.now,
      });
    }

    const [consent] = await tx
      .insert(schema.consentRecords)
      .values({
        userId: user.id,
        familyId: input.familyId,
        consentType: 'sms_service_messages',
        granted: true,
        consentScope: 'linq_group_member',
        policyVersion: POLICY_VERSION,
        evidence: {
          interpretation: 'a household parent added this number to the family group',
          channel: 'imessage',
        },
      })
      .returning({ id: schema.consentRecords.id });
    if (!consent) throw new Error('linq group member: consent insert returned no row');

    await tx.insert(schema.parentChannels).values({
      userId: user.id,
      familyId: input.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(input.phone),
      phoneE164Hash: phoneHash,
      verifiedAt: input.now,
      consentRecordId: consent.id,
    });
    return user.id;
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
): Promise<'sent' | 'already_sent' | 'not_sent'> {
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
    await database.insert(schema.auditLog).values({
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
    console.warn({ familyId: input.familyId, code }, 'linq group member: the line did not land');
    return 'not_sent';
  }
}

/**
 * Seat the person Linq added. Hale (`isFromMe`, or no named actor) seats too.
 * A household parent, or Hale when Linq names nobody, gets one welcome.
 */
export async function seatParticipantAdded(
  database: Database,
  input: {
    chatId: string;
    participantHandle: string;
    actorHandle: string | null;
    isFromMe: boolean;
    now: Date;
    send?: SendGroup;
  },
): Promise<SeatParticipantResult> {
  if (!linqGroupMembersEnabled()) return { outcome: 'flag_off' };
  const phone = seatablePhone(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  const familyId = await familyIdForChat(database, input.chatId);
  if (!familyId) return { outcome: 'group_unclaimed' };

  const actor = await actorIsHouseholdParent(database, familyId, input.actorHandle);
  const actorPhone = input.actorHandle ? normalizePhoneE164(input.actorHandle) : null;
  const decision = classifyParticipantAdd({
    participantPhone: phone,
    actorHandle: input.actorHandle,
    isFromMe: input.isFromMe,
    actorIsHouseholdParent: actor.parent,
    actorIsHale: actorPhone ? haleLine(actorPhone) : false,
  });
  if (!decision.seat) {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'linq_group_member_refused',
      targetTable: 'linq_group_members',
      targetId: familyId,
      after: { reason: 'actor' },
    });
    return { outcome: 'group_member_refused', reason: 'actor' };
  }

  const existing = await resolveVerifiedChannelByPhone(database, phone);
  if (existing && existing.familyId !== familyId) {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: actor.userId ?? 'system',
      actionTaken: 'linq_group_member_refused',
      targetTable: 'linq_group_members',
      targetId: familyId,
      after: { reason: 'other_family' },
    });
    return { outcome: 'group_member_refused', reason: 'other_family' };
  }

  const hash = phoneBlindIndex(phone);
  const seats = await liveSeats(database);
  const live = seats.find((row) => row.phoneE164Hash === hash && row.removedAt == null);
  if (live && (live.familyId !== familyId || live.chatId !== input.chatId)) {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: actor.userId ?? 'system',
      actionTaken: 'linq_group_member_refused',
      targetTable: 'linq_group_members',
      targetId: live.id,
      after: { reason: live.familyId !== familyId ? 'other_family' : 'other_chat' },
    });
    return {
      outcome: 'group_member_refused',
      reason: live.familyId !== familyId ? 'other_family' : 'other_chat',
    };
  }
  if (live) return { outcome: 'group_member_already' };

  const familyRole = existing ? await familyRoleOf(database, familyId, existing.userId) : null;
  const hasCoParent = await familyHasCoParent(database, familyId);
  const role = groupRoleFor(familyRole, hasCoParent);
  const userId =
    existing?.userId ??
    (await provisionMember(database, {
      familyId,
      phone,
      role,
      invitedByUserId: actor.userId,
      chatId: input.chatId,
      now: input.now,
    }));

  const [inserted] = await database
    .insert(schema.linqGroupMembers)
    .values({
      familyId,
      chatId: input.chatId,
      userId,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: hash,
      role,
      addedByUserId: actor.userId,
      seatedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: schema.linqGroupMembers.id });
  if (!inserted) throw new Error('linq group member: seat insert returned no row');

  await database.insert(schema.auditLog).values({
    familyId,
    actor: actor.userId ?? userId,
    actionTaken: 'linq_group_member_seated',
    targetTable: 'linq_group_members',
    targetId: inserted.id,
    after: { role, via: decision.kind },
  });

  const alreadyParent = familyRole === 'primary_parent' || familyRole === 'co_parent';
  const priorWelcome = seats.some(
    (row) => row.chatId === input.chatId && row.phoneE164Hash === hash && row.welcomedAt != null,
  );
  if (!decision.welcome || alreadyParent || priorWelcome) {
    return { outcome: 'group_member_seated', role, notice: 'skipped' };
  }

  const primary = await primaryParentId(database, familyId);
  if (!primary) {
    console.warn(
      { familyId, outcome: 'no_primary_parent' },
      'linq group member: welcome was not ledgered',
    );
    return { outcome: 'group_member_seated', role, notice: 'no_primary_parent' };
  }
  const notice = await sendOnce(database, {
    familyId,
    parentUserId: primary,
    chatId: input.chatId,
    text: LINQ_GROUP_MEMBER_WELCOME,
    templateKey: WELCOME_TEMPLATE,
    dedupeKey: `${WELCOME_TEMPLATE}:${input.chatId}:${hash}`,
    now: input.now,
    send: input.send,
  });
  if (notice === 'sent' || notice === 'already_sent') {
    await database
      .update(schema.linqGroupMembers)
      .set({ welcomedAt: input.now, updatedAt: input.now })
      .where(eq(schema.linqGroupMembers.id, inserted.id));
  }
  return { outcome: 'group_member_seated', role, notice };
}

/** Unseat the person Linq removed, including when Hale removed them. */
export async function unseatParticipantRemoved(
  database: Database,
  input: {
    chatId: string;
    participantHandle: string;
    now: Date;
  },
): Promise<
  | { outcome: 'flag_off' }
  | { outcome: 'ignored' }
  | { outcome: 'group_member_unseated' }
  | { outcome: 'group_member_absent' }
> {
  if (!linqGroupMembersEnabled()) return { outcome: 'flag_off' };
  const phone = seatablePhone(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  const hash = phoneBlindIndex(phone);
  const seats = await liveSeats(database);
  const live = seats.find(
    (row) => row.chatId === input.chatId && row.phoneE164Hash === hash && row.removedAt == null,
  );
  if (!live) return { outcome: 'group_member_absent' };
  await database
    .update(schema.linqGroupMembers)
    .set({ removedAt: input.now, updatedAt: input.now })
    .where(and(eq(schema.linqGroupMembers.id, live.id), isNull(schema.linqGroupMembers.removedAt)));
  await database.insert(schema.auditLog).values({
    familyId: live.familyId,
    actor: 'system',
    actionTaken: 'linq_group_member_unseated',
    targetTable: 'linq_group_members',
    targetId: live.id,
    after: { role: live.role },
  });
  return { outcome: 'group_member_unseated' };
}

/**
 * The existing unknown-sender hold, once per phone per chat, ledgered on the
 * primary parent. A second text from the same number does not send again.
 */
export async function holdTrueStrangerOnce(
  database: Database,
  input: {
    chatId: string;
    senderHandle: string;
    now: Date;
    send?: SendGroup;
  },
): Promise<'sent' | 'already_sent' | 'not_sent' | 'no_primary_parent' | 'not_a_phone' | 'no_family'> {
  const phone = seatablePhone(input.senderHandle);
  if (!phone) return 'not_a_phone';
  const familyId = await familyIdForChat(database, input.chatId);
  if (!familyId) return 'no_family';
  const primary = await primaryParentId(database, familyId);
  if (!primary) {
    console.warn(
      { familyId, outcome: 'no_primary_parent' },
      'linq group member: stranger hold was not ledgered',
    );
    return 'no_primary_parent';
  }
  const hash = phoneBlindIndex(phone);
  const notice = await sendOnce(database, {
    familyId,
    parentUserId: primary,
    chatId: input.chatId,
    text: LINQ_GROUP_UNKNOWN_HOLD,
    templateKey: HOLD_TEMPLATE,
    dedupeKey: `${HOLD_TEMPLATE}:${input.chatId}:${hash}`,
    now: input.now,
    send: input.send,
  });
  if (notice === 'sent') {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: primary,
      actionTaken: 'linq_group_stranger_held',
      targetTable: 'channel_messages',
      targetId: familyId,
      after: { outcome: 'unknown_sender' },
    });
  }
  return notice;
}

/** A claimed group, and this sender is not a parent or a live seat. */
export async function shouldHoldGroupStranger(
  database: Database,
  input: { chatId: string; senderHandle: string },
): Promise<boolean> {
  if (!linqGroupMembersEnabled()) return false;
  const phone = seatablePhone(input.senderHandle);
  if (!phone) return false;
  const familyId = await familyIdForChat(database, input.chatId);
  if (!familyId) return false;
  return !(await speakerBelongs(database, familyId, input.chatId, phone));
}

async function speakerBelongs(
  database: Database,
  familyId: string,
  chatId: string,
  phone: string,
): Promise<boolean> {
  const existing = await resolveVerifiedChannelByPhone(database, phone);
  if (existing && existing.familyId === familyId) {
    const role = await familyRoleOf(database, familyId, existing.userId);
    if (role && isParentRole(role)) return true;
  }
  const hash = phoneBlindIndex(phone);
  const seats = await liveSeats(database);
  return seats.some(
    (row) =>
      row.familyId === familyId &&
      row.chatId === chatId &&
      row.phoneE164Hash === hash &&
      row.removedAt == null,
  );
}

/** Live seat of any role. Flag off is false, so the parent gate stays shut. */
export async function liveMemberMayTalk(
  database: Database,
  familyId: string,
  userId: string,
  chatId: string,
): Promise<boolean> {
  if (!linqGroupMembersEnabled()) return false;
  const seats = await liveSeats(database);
  return seats.some(
    (row) =>
      row.familyId === familyId &&
      row.userId === userId &&
      row.chatId === chatId &&
      row.removedAt == null,
  );
}

/**
 * A live other_family or caregiver seat cannot connect a calendar or mailbox,
 * authorize spend or a signup, or change family memory. Parents are unchanged.
 * Flag off is false.
 */
export async function liveSeatBlocksPrivileged(
  database: Database,
  userId: string,
): Promise<boolean> {
  if (!linqGroupMembersEnabled()) return false;
  const seats = await liveSeats(database);
  const live = seats.filter((row) => row.userId === userId && row.removedAt == null);
  if (live.length === 0) return false;
  return live.every((row) => row.role === 'other_family' || row.role === 'caregiver');
}

/** True when this turn must not perform the privileged action. Audits the refusal. */
export async function declinePrivilegedGroupSeat(
  database: Database,
  input: { familyId: string; userId: string; capability: string },
): Promise<boolean> {
  if (!(await liveSeatBlocksPrivileged(database, input.userId))) return false;
  await auditPrivilegedDecline(database, input);
  return true;
}

export async function auditPrivilegedDecline(
  database: Database,
  input: { familyId: string; userId: string; capability: string },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.userId,
    actionTaken: 'linq_group_member_refused',
    targetTable: 'linq_group_members',
    targetId: input.userId,
    after: { capability: input.capability },
  });
}

/**
 * Who may be named on a duty. Flag off is the two parent seats. Flag on adds
 * every live group member. Callers still spend the ask budget on the
 * household chat, not on each of these ids.
 */
export async function dutyAssigneeIds(database: Database, familyId: string): Promise<string[]> {
  const members = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const parents = [
    ...new Set(
      members
        .filter(
          (row) =>
            row.familyId === familyId &&
            (row.role === 'primary_parent' || row.role === 'co_parent') &&
            row.userId,
        )
        .map((row) => row.userId as string),
    ),
  ];
  if (!linqGroupMembersEnabled()) return parents;
  const seats = await liveSeats(database);
  const live = seats
    .filter((row) => row.familyId === familyId && row.removedAt == null && row.userId)
    .map((row) => row.userId);
  return [...new Set([...parents, ...live])];
}

/** A non-parent family member with no live seat is not routed as a member. */
export async function nonParentWithoutLiveSeat(
  database: Database,
  input: { familyId: string; userId: string; chatId: string },
): Promise<boolean> {
  if (!linqGroupMembersEnabled()) return false;
  const role = await familyRoleOf(database, input.familyId, input.userId);
  if (!role || isParentRole(role)) return false;
  return !(await liveMemberMayTalk(database, input.familyId, input.userId, input.chatId));
}
