import { type Database, schema } from '@hale/db';
import { and, eq, notInArray } from 'drizzle-orm';
import { type ContentClass, ROLE_SCOPE } from '~/lib/channel/role-scope';
import { linqGroupOnboardingV2Enabled } from './config';
import { isUndefinedTable } from './roster';

/**
 * Group onboarding v2 — what a family group may hear.
 *
 * Everyone in the chat reads every group line, so the group's scope is the narrowest
 * scope in it: the intersection of `ROLE_SCOPE` over every live member. A known parent
 * or a confirmed co-parent brings the parent scope, a confirmed grandparent, nanny or
 * babysitter the caregiver scope, and anyone who has not said who they are, said "not
 * family", stopped, or belongs to another family brings nothing. Only kid lines ever
 * qualify (`GROUP_CONTENT`): health, registration, settings and suggestions stay 1:1
 * even in a chat of parents.
 *
 * Until the roster is `confirmed`, the only group lines are the roster's own (asks,
 * acknowledgements, STOP) and a direct `reply` to someone in the thread. A `confirmed`
 * chat whose scope is empty takes nothing at all. A send that names no content class
 * is refused once the flag is on: a class nobody stated cannot be proved to be in scope.
 *
 * Flag off is today's rule (a claimed chat takes everything). The roster tables are read
 * on every group send, so a missing table is the named `not_migrated` refusal.
 */

export const GROUP_CONTENT: readonly ContentClass[] = [
  'schedule',
  'pickup_duty',
  'event_logistics',
];

/** `reply` answers someone in the thread and carries no household content. */
export type GroupLineClass = ContentClass | 'reply' | 'unclassified';

export type GroupHoldReason =
  | 'not_migrated'
  | 'group_roles_unconfirmed'
  | 'group_audience_empty'
  | 'group_audience_refused';

export type GroupAudienceVerdict =
  | { allowed: true; reason: 'flag_off' | 'not_household_group' | 'in_scope' }
  | { allowed: false; reason: GroupHoldReason };

const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];
const ASKING: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial'];

type AudienceMember = {
  status: schema.LinqRosterMemberStatus;
  confirmedRole: schema.LinqRosterConfirmedRole | null;
};

function memberScope(member: AudienceMember): ReadonlySet<ContentClass> {
  if (member.status === 'known_parent') return ROLE_SCOPE.primary_parent;
  if (member.status === 'confirmed' && member.confirmedRole) {
    // Aunt, uncle, and cousin are family. Their 1:1 scope stays empty. In a group
    // they may hear the same kid lines a grandparent hears.
    if (member.confirmedRole === 'extended') return ROLE_SCOPE.grandparent;
    return ROLE_SCOPE[member.confirmedRole];
  }
  return new Set();
}

/** The classes every live member may see. A chat nobody is left in has no audience. */
export function audienceScope(members: readonly AudienceMember[]): Set<ContentClass> {
  if (members.length === 0) return new Set();
  return new Set(
    GROUP_CONTENT.filter((contentClass) =>
      members.every((member) => memberScope(member).has(contentClass)),
    ),
  );
}

export type RosterAudience = {
  rosterId: string;
  familyId: string | null;
  status: schema.LinqGroupRosterStatus;
  members: AudienceMember[];
};

export async function readRosterAudience(
  database: Database,
  chatId: string,
): Promise<RosterAudience | null | 'not_migrated'> {
  try {
    const [roster] = await database
      .select({
        id: schema.linqGroupRosters.id,
        familyId: schema.linqGroupRosters.familyId,
        status: schema.linqGroupRosters.status,
      })
      .from(schema.linqGroupRosters)
      .where(eq(schema.linqGroupRosters.chatId, chatId));
    if (!roster) return null;
    const members = await database
      .select({
        status: schema.linqGroupRosterMembers.status,
        confirmedRole: schema.linqGroupRosterMembers.confirmedRole,
      })
      .from(schema.linqGroupRosterMembers)
      .where(
        and(
          eq(schema.linqGroupRosterMembers.rosterId, roster.id),
          notInArray(schema.linqGroupRosterMembers.status, GONE),
        ),
      );
    return { rosterId: roster.id, familyId: roster.familyId, status: roster.status, members };
  } catch (err) {
    if (isUndefinedTable(err)) return 'not_migrated';
    throw err;
  }
}

/** `linq_group_sends_held`, once per roster: the household's trail says why the group is quiet. */
async function noteSendsHeld(
  database: Database,
  roster: { rosterId: string; familyId: string },
): Promise<void> {
  const [prior] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, roster.familyId),
        eq(schema.auditLog.actionTaken, 'linq_group_sends_held'),
        eq(schema.auditLog.targetId, roster.rosterId),
      ),
    )
    .limit(1);
  if (prior) return;
  await database.insert(schema.auditLog).values({
    familyId: roster.familyId,
    actor: 'system',
    actionTaken: 'linq_group_sends_held',
    targetTable: 'linq_group_rosters',
    targetId: roster.rosterId,
    after: { reason: 'group_roles_unconfirmed' },
  });
}

function refused(reason: GroupHoldReason, lineClass: GroupLineClass): GroupAudienceVerdict {
  console.info({ outcome: reason, lineClass }, 'linq group audience: not sent into the group');
  return { allowed: false, reason };
}

export async function groupAudienceAllows(
  database: Database,
  chatId: string,
  lineClass: GroupLineClass,
): Promise<GroupAudienceVerdict> {
  if (!linqGroupOnboardingV2Enabled()) return { allowed: true, reason: 'flag_off' };
  const roster = await readRosterAudience(database, chatId);
  if (roster === 'not_migrated') return refused('not_migrated', lineClass);

  if (!roster) {
    const [holder] = await database
      .select({ id: schema.families.id })
      .from(schema.families)
      .where(eq(schema.families.linqGroupChatId, chatId))
      .limit(1);
    if (!holder) return { allowed: true, reason: 'not_household_group' };
    if (lineClass === 'reply') return { allowed: true, reason: 'in_scope' };
    return refused('group_roles_unconfirmed', lineClass);
  }

  if (roster.status !== 'confirmed') {
    if (lineClass === 'reply' && ASKING.includes(roster.status)) {
      return { allowed: true, reason: 'in_scope' };
    }
    if (roster.familyId) {
      await noteSendsHeld(database, { rosterId: roster.rosterId, familyId: roster.familyId });
    }
    return refused('group_roles_unconfirmed', lineClass);
  }

  const scope = audienceScope(roster.members);
  if (scope.size === 0) return refused('group_audience_empty', lineClass);
  if (lineClass === 'reply') return { allowed: true, reason: 'in_scope' };
  if (lineClass === 'unclassified' || !scope.has(lineClass)) {
    return refused('group_audience_refused', lineClass);
  }
  return { allowed: true, reason: 'in_scope' };
}
