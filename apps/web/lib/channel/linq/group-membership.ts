import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * VIL-438 (T22) — who is in a household Linq group, and what covers them.
 *
 * Read model only: no sends, no model calls, no writes. Seating stays in
 * group-members.ts. Decisions (2026-10-21, Barton via Sloane):
 * - One family's plan covers everyone seated in its group. A partner, nanny or
 *   grandparent never needs their own sign-up or plan.
 * - A member who is not a Hale customer (seated only through the group) is
 *   flagged so later tickets keep their asks in the group (T26).
 * There is no member cap.
 */

export type PlanTier = schema.Family['planTier'];

export type GroupMember = {
  userId: string;
  role: schema.LinqGroupMember['role'];
  /** True when this person signed up with Hale themselves, not only via the group. */
  haleCustomer: boolean;
};

export type GroupMembership = {
  chatId: string;
  familyId: string;
  /** The covering family's plan. Applies to every live member. */
  planTier: PlanTier;
  members: GroupMember[];
};

/** Pure: one plan covers the whole group, so every member gets the family tier. */
export function memberPlanTier(membership: Pick<GroupMembership, 'planTier'>): PlanTier {
  return membership.planTier;
}

/** Group-seat consent scope written by group-members.ts provisionMember. */
const GROUP_SEAT_SCOPE = 'linq_group_member';

export async function readGroupMembership(
  database: Database,
  chatId: string,
): Promise<GroupMembership | null> {
  const [family] = await database
    .select({ id: schema.families.id, planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.linqGroupChatId, chatId))
    .limit(1);
  if (!family) return null;

  const seats = await database
    .select({ userId: schema.linqGroupMembers.userId, role: schema.linqGroupMembers.role })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, chatId),
        eq(schema.linqGroupMembers.familyId, family.id),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );

  const consents = await database
    .select({
      userId: schema.consentRecords.userId,
      scope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
    })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.familyId, family.id));

  const members = seats.map((seat) => {
    const own = consents.filter((c) => c.userId === seat.userId && c.granted);
    const groupOnly = own.length > 0 && own.every((c) => c.scope === GROUP_SEAT_SCOPE);
    return {
      userId: seat.userId,
      role: seat.role,
      haleCustomer: seat.role === 'parent' || !groupOnly,
    };
  });

  return { chatId, familyId: family.id, planTier: family.planTier, members };
}

/** The live member behind a phone in this chat, or null when they are not seated. */
export async function groupMemberByPhone(
  database: Database,
  chatId: string,
  handle: string,
): Promise<(GroupMember & { planTier: PlanTier; familyId: string }) | null> {
  const phone = normalizePhoneE164(handle);
  if (!phone) return null;
  const membership = await readGroupMembership(database, chatId);
  if (!membership) return null;
  const [seat] = await database
    .select({ userId: schema.linqGroupMembers.userId })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, chatId),
        eq(schema.linqGroupMembers.phoneE164Hash, phoneBlindIndex(phone)),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    )
    .limit(1);
  const member = seat && membership.members.find((m) => m.userId === seat.userId);
  if (!member) return null;
  return { ...member, planTier: memberPlanTier(membership), familyId: membership.familyId };
}
