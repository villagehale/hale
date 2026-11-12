import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import {
  type GroupPlan,
  type GroupPlanCopyStore,
  createFamilyEventsCopyStore,
} from '../group-plan-invites';

/**
 * VIL-399 scene 04 — the event lands only on calendars of families who said yes.
 * No / maybe / waiting get no copy. A plan without a start is not placed.
 */
export async function yesFamilyIdsForPlan(database: Database, planId: string): Promise<string[]> {
  const rsvps = await database
    .select({
      userId: schema.linqGroupPlanRsvps.userId,
      response: schema.linqGroupPlanRsvps.response,
    })
    .from(schema.linqGroupPlanRsvps)
    .where(eq(schema.linqGroupPlanRsvps.planId, planId));
  const yesUserIds = rsvps
    .filter((row) => row.response === 'yes' && row.userId)
    .map((row) => row.userId as string);
  if (yesUserIds.length === 0) return [];
  const members = await database
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(inArray(schema.familyMembers.userId, yesUserIds));
  return [...new Set(members.map((row) => row.familyId))];
}

export async function placeYesFamilyCalendars(
  copies: GroupPlanCopyStore,
  plan: GroupPlan,
  yesFamilyIds: readonly string[],
): Promise<{ familyId: string; placed: boolean }[]> {
  const out: { familyId: string; placed: boolean }[] = [];
  for (const familyId of yesFamilyIds) {
    try {
      const write = await copies.upsertCopy(plan, familyId);
      out.push({ familyId, placed: write.status === 'written' || write.status === 'unchanged' });
    } catch (err) {
      console.warn(
        { familyId, err: err instanceof Error ? err.name : 'unknown' },
        'group experience: yes-family calendar was not placed',
      );
      out.push({ familyId, placed: false });
    }
  }
  return out;
}

export function postgresYesCalendarCopies(database: Database): GroupPlanCopyStore {
  return createFamilyEventsCopyStore(database);
}

export async function planAsGroupPlan(
  database: Database,
  planId: string,
  chatId: string,
): Promise<GroupPlan | null> {
  const [plan] = await database
    .select()
    .from(schema.linqGroupPlans)
    .where(and(eq(schema.linqGroupPlans.id, planId), eq(schema.linqGroupPlans.chatId, chatId)))
    .limit(1);
  if (!plan || !plan.startsAt) return null;
  return {
    groupPlanId: plan.id,
    chatId: plan.chatId,
    title: plan.title,
    startsAt: plan.startsAt,
    endsAt: null,
    location: plan.location,
    cancelled: false,
  };
}
