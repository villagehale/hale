import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import type { SpokenLineComposer } from '~/lib/channel/voice/spoken-line';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { linqFromE164, linqGroupMembersEnabled, linqGroupOnboardingV2Enabled } from './config';
import type { GroupLineSend } from './group-onboarding-voice';
import { type MemberAskOutcome, askMember } from './roster-ask';

/**
 * VIL-398 — seats in a claimed household Linq group.
 *
 * A seat is written only on the person's own reply to the roster ask
 * (roster-seat.ts); nothing here seats anyone. Someone added to the group is
 * asked, once, who they are (group onboarding v2, off unless
 * `LINQ_GROUP_ONBOARDING_V2_ENABLED` is `true`). Removal unseats, and the seat
 * reads below stay behind `LINQ_GROUP_MEMBERS_ENABLED`.
 */

async function familyIdForChat(database: Database, chatId: string): Promise<string | null> {
  const rows = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return rows.find((row) => row.linqGroupChatId === chatId)?.id ?? null;
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

export type AskParticipantResult =
  | { outcome: 'flag_off' }
  | { outcome: 'group_unclaimed' }
  | MemberAskOutcome;

/**
 * Someone was added to a claimed group: ask them, once, who they are. The add itself
 * seats nobody and grants nothing; their own reply does (roster-turn.ts).
 */
export async function askParticipantAdded(
  database: Database,
  input: {
    chatId: string;
    participantHandle: string;
    now: Date;
    voice: SpokenLineComposer | undefined;
    send?: GroupLineSend;
  },
): Promise<AskParticipantResult> {
  if (!linqGroupOnboardingV2Enabled()) return { outcome: 'flag_off' };
  const phone = seatablePhone(input.participantHandle);
  if (!phone) return { outcome: 'ignored' };
  const familyId = await familyIdForChat(database, input.chatId);
  if (!familyId) return { outcome: 'group_unclaimed' };
  return askMember(database, {
    chatId: input.chatId,
    phone,
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
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
