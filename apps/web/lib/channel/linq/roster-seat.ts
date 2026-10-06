import { type Database, schema } from '@hale/db';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { storeParentRole } from '~/lib/channel/identity/parent-role';
import { resolveVerifiedChannelByPhone } from '~/lib/channels/sms-consent-core';
import { POLICY_VERSION } from '~/lib/consent';
import { decryptString } from '~/lib/crypto/string-cipher';
import type { RosterParentRole } from './roster-reading';

/**
 * Group onboarding v2 — a seat in the family, written only on the person's own reply.
 *
 * The reply is the consent: it is stored verbatim beside Hale's reading of it. A parent
 * is a `co_parent` (scope `linq_group_role_reply`); a grandparent, nanny or babysitter
 * gets that scoped role and the caregiver consent `caregiver:<role>`. `extended` and
 * `service` are never written. A phone already verified in another family is refused
 * and named; nothing about this family is written for it.
 */

export type SeatRole = 'co_parent' | 'grandparent' | 'nanny' | 'babysitter';
type GroupSeatRole = schema.LinqGroupMemberRole;
type CaregiverRole = Exclude<SeatRole, 'co_parent'>;

export type SeatReading =
  | { role: 'parent'; parentRole: RosterParentRole }
  | { role: CaregiverRole; parentRole: null };

export type SeatRefusal = 'other_family' | 'other_chat' | 'co_parent_seat_taken';

export type SeatOutcome =
  | { outcome: 'seated'; userId: string; role: SeatRole; groupRole: GroupSeatRole }
  | { outcome: 'seat_refused'; reason: SeatRefusal }
  | { outcome: 'member_not_asked' };

/** A member nobody needs to hear from again; a roster of only these is `confirmed`. */
export const TERMINAL: readonly schema.LinqRosterMemberStatus[] = [
  'known_parent',
  'confirmed',
  'declined',
  'not_family',
  'refused',
  'left',
  'removed',
];
const ASKED: readonly schema.LinqRosterMemberStatus[] = ['asked', 'reasked'];
const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];
const OPEN_ROSTER: readonly schema.LinqGroupRosterStatus[] = [
  'roles_proposed',
  'partial',
  'confirmed',
];

const GROUP_ROLE: Record<SeatRole, GroupSeatRole> = {
  co_parent: 'co_parent',
  grandparent: 'other_family',
  nanny: 'caregiver',
  babysitter: 'caregiver',
};

interface AskedMember {
  id: string;
  rosterId: string;
  chatId: string;
  familyId: string;
  phone: string;
  phoneE164Hash: string;
  phoneE164Encrypted: string;
}

async function loadAskedMember(
  database: Database,
  rosterMemberId: string,
): Promise<AskedMember | null> {
  const [row] = await database
    .select({
      id: schema.linqGroupRosterMembers.id,
      rosterId: schema.linqGroupRosterMembers.rosterId,
      chatId: schema.linqGroupRosterMembers.chatId,
      status: schema.linqGroupRosterMembers.status,
      phoneE164Hash: schema.linqGroupRosterMembers.phoneE164Hash,
      phoneE164Encrypted: schema.linqGroupRosterMembers.phoneE164Encrypted,
      familyId: schema.linqGroupRosters.familyId,
      rosterStatus: schema.linqGroupRosters.status,
    })
    .from(schema.linqGroupRosterMembers)
    .innerJoin(
      schema.linqGroupRosters,
      eq(schema.linqGroupRosters.id, schema.linqGroupRosterMembers.rosterId),
    )
    .where(eq(schema.linqGroupRosterMembers.id, rosterMemberId));
  if (!row || !row.familyId) return null;
  if (!ASKED.includes(row.status) || !OPEN_ROSTER.includes(row.rosterStatus)) return null;
  return {
    id: row.id,
    rosterId: row.rosterId,
    chatId: row.chatId,
    familyId: row.familyId,
    phone: decryptString(row.phoneE164Encrypted),
    phoneE164Hash: row.phoneE164Hash,
    phoneE164Encrypted: row.phoneE164Encrypted,
  };
}

/**
 * `partial` while anyone live is still to answer and someone has confirmed; `confirmed`
 * once every live member is settled. A roster that is not open is left alone.
 */
export async function settleRosterStatus(
  database: Database,
  rosterId: string,
  now: Date,
): Promise<schema.LinqGroupRosterStatus | null> {
  const [roster] = await database
    .select({ status: schema.linqGroupRosters.status })
    .from(schema.linqGroupRosters)
    .where(eq(schema.linqGroupRosters.id, rosterId));
  if (!roster || !OPEN_ROSTER.includes(roster.status)) return roster?.status ?? null;
  const live = await database
    .select({ status: schema.linqGroupRosterMembers.status })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, rosterId),
        notInArray(schema.linqGroupRosterMembers.status, GONE),
      ),
    );
  const settled = live.every((member) => TERMINAL.includes(member.status));
  const status: schema.LinqGroupRosterStatus = settled
    ? 'confirmed'
    : live.some((member) => member.status === 'confirmed')
      ? 'partial'
      : 'roles_proposed';
  await database
    .update(schema.linqGroupRosters)
    .set({ status, confirmedAt: settled ? now : null, updatedAt: now })
    .where(eq(schema.linqGroupRosters.id, rosterId));
  return status;
}

async function refuse(
  database: Database,
  member: AskedMember,
  reason: SeatRefusal,
  now: Date,
): Promise<SeatOutcome> {
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: 'refused', updatedAt: now })
    .where(eq(schema.linqGroupRosterMembers.id, member.id));
  await database.insert(schema.auditLog).values({
    familyId: member.familyId,
    actor: 'system',
    actionTaken: 'linq_group_member_refused',
    targetTable: 'linq_group_roster_members',
    targetId: member.id,
    after: { reason, via: 'own_reply' },
  });
  await settleRosterStatus(database, member.rosterId, now);
  console.info({ outcome: 'seat_refused', reason }, 'linq roster: seat refused');
  return { outcome: 'seat_refused', reason };
}

/**
 * One transaction: identity, family role, consent with the verbatim reply, a verified
 * channel, the group seat, the roster member, and the audit rows. Only a member Hale
 * asked can be seated.
 */
export async function seatConfirmedMember(
  database: Database,
  input: { rosterMemberId: string; reading: SeatReading; verbatimReply: string; now: Date },
): Promise<SeatOutcome> {
  const member = await loadAskedMember(database, input.rosterMemberId);
  if (!member) return { outcome: 'member_not_asked' };
  const role: SeatRole = input.reading.role === 'parent' ? 'co_parent' : input.reading.role;
  const groupRole = GROUP_ROLE[role];

  const existing = await resolveVerifiedChannelByPhone(database, member.phone);
  if (existing && existing.familyId !== member.familyId) {
    return refuse(database, member, 'other_family', input.now);
  }
  const [liveSeat] = await database
    .select({ chatId: schema.linqGroupMembers.chatId })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.phoneE164Hash, member.phoneE164Hash),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );
  if (liveSeat && liveSeat.chatId !== member.chatId) {
    return refuse(database, member, 'other_chat', input.now);
  }
  if (role === 'co_parent') {
    const [coParent] = await database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, member.familyId),
          eq(schema.familyMembers.role, 'co_parent'),
        ),
      );
    if (coParent && coParent.userId !== existing?.userId) {
      return refuse(database, member, 'co_parent_seat_taken', input.now);
    }
  }

  const userId = await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const externalAuthId = `sms:${member.phoneE164Hash}`;
    await tx
      .insert(schema.users)
      .values({ externalAuthId, email: null, name: null })
      .onConflictDoNothing({ target: schema.users.externalAuthId });
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalAuthId, externalAuthId))
      .limit(1);
    const seatedUserId = existing?.userId ?? user?.id;
    if (!seatedUserId) throw new Error('seatConfirmedMember: users insert returned no row');

    await tx
      .insert(schema.familyMembers)
      .values({ familyId: member.familyId, userId: seatedUserId, role })
      .onConflictDoUpdate({
        target: [schema.familyMembers.familyId, schema.familyMembers.userId],
        set: { role },
      });
    if (role === 'co_parent') {
      await tx
        .insert(schema.loopPrefs)
        .values({ userId: seatedUserId, loopChannel: 'sms' })
        .onConflictDoNothing({ target: schema.loopPrefs.userId });
    }

    const evidence = {
      verbatimReply: input.verbatimReply,
      interpretation: { role, parentRole: input.reading.parentRole },
      channel: 'imessage',
      chatId: member.chatId,
    };
    const [consent] = await tx
      .insert(schema.consentRecords)
      .values(
        role === 'co_parent'
          ? {
              userId: seatedUserId,
              familyId: member.familyId,
              consentType: 'sms_service_messages' as const,
              granted: true,
              consentScope: 'linq_group_role_reply',
              policyVersion: POLICY_VERSION,
              evidence,
            }
          : {
              userId: seatedUserId,
              familyId: member.familyId,
              consentType: 'caregiver_scoped_messages' as const,
              granted: true,
              consentScope: `caregiver:${role}`,
              policyVersion: POLICY_VERSION,
              evidence,
            },
      )
      .returning({ id: schema.consentRecords.id });
    if (!consent) throw new Error('seatConfirmedMember: consent insert returned no row');

    if (!existing) {
      await tx.insert(schema.parentChannels).values({
        userId: seatedUserId,
        familyId: member.familyId,
        kind: 'sms',
        phoneE164Encrypted: member.phoneE164Encrypted,
        phoneE164Hash: member.phoneE164Hash,
        verifiedAt: input.now,
        consentRecordId: consent.id,
      });
    }

    let seatId: string | undefined;
    if (!liveSeat) {
      const [seat] = await tx
        .insert(schema.linqGroupMembers)
        .values({
          familyId: member.familyId,
          chatId: member.chatId,
          userId: seatedUserId,
          phoneE164Encrypted: member.phoneE164Encrypted,
          phoneE164Hash: member.phoneE164Hash,
          role: groupRole,
          seatedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning({ id: schema.linqGroupMembers.id });
      seatId = seat?.id;
    }

    await tx
      .update(schema.linqGroupRosterMembers)
      .set({
        status: 'confirmed',
        confirmedRole: role,
        userId: seatedUserId,
        confirmedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(schema.linqGroupRosterMembers.id, member.id));

    if (input.reading.role === 'parent' && input.reading.parentRole) {
      await storeParentRole(tx, {
        familyId: member.familyId,
        parentUserId: seatedUserId,
        guess: { role: input.reading.parentRole, basis: 'stated' },
      });
    }

    await tx.insert(schema.auditLog).values([
      {
        familyId: member.familyId,
        actor: seatedUserId,
        actionTaken: 'linq_group_role_confirmed',
        targetTable: 'linq_group_roster_members',
        targetId: member.id,
        after: { role, via: 'own_reply' },
      },
      {
        familyId: member.familyId,
        actor: seatedUserId,
        actionTaken: 'linq_group_member_seated',
        targetTable: 'linq_group_members',
        targetId: seatId ?? member.id,
        after: { role: groupRole, via: 'own_reply' },
      },
    ]);
    await settleRosterStatus(tx, member.rosterId, input.now);
    return seatedUserId;
  });

  console.info({ outcome: 'seated', role }, 'linq roster: member seated on their own reply');
  return { outcome: 'seated', userId, role, groupRole };
}

/** "Not family" or "leave me out": no identity, no seat, no consent. The member is settled. */
export async function declineRosterMember(
  database: Database,
  input: { rosterMemberId: string; status: 'declined' | 'not_family'; now: Date },
): Promise<
  { outcome: 'declined'; status: 'declined' | 'not_family' } | { outcome: 'member_not_asked' }
> {
  const member = await loadAskedMember(database, input.rosterMemberId);
  if (!member) return { outcome: 'member_not_asked' };
  await database
    .update(schema.linqGroupRosterMembers)
    .set({ status: input.status, updatedAt: input.now })
    .where(eq(schema.linqGroupRosterMembers.id, member.id));
  await database.insert(schema.auditLog).values({
    familyId: member.familyId,
    actor: 'system',
    actionTaken: 'linq_group_role_declined',
    targetTable: 'linq_group_roster_members',
    targetId: member.id,
    after: { status: input.status },
  });
  await settleRosterStatus(database, member.rosterId, input.now);
  return { outcome: 'declined', status: input.status };
}

/**
 * Take back a grandparent, nanny or babysitter seat this group granted: the seat closes,
 * the family role goes, and the caregiver consent is withdrawn on the same scope. A
 * co-parent leaves through the departure flow instead. Their 1:1 channel is untouched.
 */
export async function unseatCaregiverSeat(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    chatId: string;
    via: 'participant_removed' | 'group_stop';
    now: Date;
  },
): Promise<
  | { outcome: 'unseated'; role: CaregiverRole }
  | { outcome: 'not_seated' }
  | { outcome: 'not_caregiver' }
> {
  const [granted] = await database
    .select({
      id: schema.linqGroupRosterMembers.id,
      rosterId: schema.linqGroupRosterMembers.rosterId,
      confirmedRole: schema.linqGroupRosterMembers.confirmedRole,
    })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.chatId, input.chatId),
        eq(schema.linqGroupRosterMembers.userId, input.userId),
        eq(schema.linqGroupRosterMembers.status, 'confirmed'),
      ),
    );
  if (!granted?.confirmedRole) return { outcome: 'not_seated' };
  if (granted.confirmedRole === 'co_parent') return { outcome: 'not_caregiver' };
  const role = granted.confirmedRole;

  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .update(schema.linqGroupMembers)
      .set({ removedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.linqGroupMembers.familyId, input.familyId),
          eq(schema.linqGroupMembers.userId, input.userId),
          eq(schema.linqGroupMembers.chatId, input.chatId),
          isNull(schema.linqGroupMembers.removedAt),
        ),
      );
    await tx
      .delete(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, input.familyId),
          eq(schema.familyMembers.userId, input.userId),
          eq(schema.familyMembers.role, role),
        ),
      );
    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'caregiver_scoped_messages',
      granted: false,
      consentScope: `caregiver:${role}`,
      policyVersion: POLICY_VERSION,
      evidence: {
        interpretation: `the ${role} seat this group granted was taken back`,
        via: input.via,
      },
    });
    await tx
      .update(schema.linqGroupRosterMembers)
      .set({ status: 'removed', updatedAt: input.now })
      .where(eq(schema.linqGroupRosterMembers.id, granted.id));
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'linq_group_member_unseated',
      targetTable: 'linq_group_members',
      targetId: granted.id,
      after: { role, via: input.via },
    });
    await settleRosterStatus(tx, granted.rosterId, input.now);
  });
  return { outcome: 'unseated', role };
}
