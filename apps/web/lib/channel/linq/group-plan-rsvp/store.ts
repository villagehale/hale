import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { readGroupMembership } from '../group-membership';
import { memberKeyFromHandle, memberKeyFromName } from './member-key';
import {
  type PlanExpectedRow,
  type PlanRsvpResponse,
  type PlanTally,
  type PlanTallyRow,
  tallyPlanRsvps,
} from './tally';

export interface GroupPlanRecord {
  id: string;
  chatId: string;
  familyId: string;
  title: string;
  startsAt: Date | null;
  location: string | null;
  rsvpDeadlineAt: Date | null;
  expectedCount: number;
}

export interface ExpectedPerson {
  memberKey: string;
  displayName: string;
  userId: string | null;
  haleCustomer: boolean;
}

export interface UpsertRsvpInput {
  planId: string;
  memberKey: string;
  displayName: string;
  householdLabel: string | null;
  userId: string | null;
  haleCustomer: boolean;
  response: PlanRsvpResponse;
  headcount: number;
  source: 'text' | 'tapback' | 'on_behalf';
  coversKeys: readonly string[];
  verbatim: string | null;
  now: Date;
}

export interface CreatePlanInput {
  chatId: string;
  familyId: string;
  title: string;
  startsAt: Date | null;
  location: string | null;
  rsvpDeadlineAt: Date | null;
  createdByUserId: string | null;
  expected: readonly ExpectedPerson[];
  now: Date;
}

export interface GroupPlanRsvpStore {
  coveringFamily(chatId: string): Promise<{ familyId: string; timeZone: string } | null>;
  loadLivePlan(chatId: string): Promise<GroupPlanRecord | null>;
  createPlan(input: CreatePlanInput): Promise<GroupPlanRecord>;
  loadTally(
    planId: string,
  ): Promise<{ tally: PlanTally; rows: PlanTallyRow[]; expected: PlanExpectedRow[] }>;
  upsertRsvp(input: UpsertRsvpInput): Promise<{ edited: boolean }>;
  addExpected(planId: string, person: ExpectedPerson): Promise<void>;
  seatedExpected(chatId: string): Promise<ExpectedPerson[]>;
  claimFollowup(planId: string, wave: number, now: Date): Promise<boolean>;
  markFollowupSent(planId: string, wave: number, now: Date): Promise<void>;
  releaseFollowup(planId: string, wave: number): Promise<void>;
  listDueFollowups(
    now: Date,
  ): Promise<{ plan: GroupPlanRecord; timeZone: string; waitingNames: string[] }[]>;
}

function flag(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

function parseCovers(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function expectedFromSeats(
  members: readonly {
    userId: string;
    haleCustomer: boolean;
    displayName: string;
    memberKey: string;
  }[],
): ExpectedPerson[] {
  return members.map((member) => ({
    memberKey: member.memberKey,
    displayName: member.displayName,
    userId: member.userId,
    haleCustomer: member.haleCustomer,
  }));
}

export async function postgresSeatedExpected(
  database: Database,
  chatId: string,
): Promise<ExpectedPerson[]> {
  const membership = await readGroupMembership(database, chatId);
  if (!membership) return [];
  const seats = await database
    .select({
      userId: schema.linqGroupMembers.userId,
      phoneHash: schema.linqGroupMembers.phoneE164Hash,
    })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, chatId),
        eq(schema.linqGroupMembers.familyId, membership.familyId),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );
  const names = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users);
  const byId = new Map(names.map((row) => [row.id, row.name]));
  return seats.map((seat) => {
    const member = membership.members.find((m) => m.userId === seat.userId);
    const displayName = byId.get(seat.userId)?.trim().split(/\s+/)[0] || 'someone';
    return {
      memberKey: seat.phoneHash,
      displayName,
      userId: seat.userId,
      haleCustomer: member?.haleCustomer ?? false,
    };
  });
}

export function createPostgresGroupPlanRsvpStore(database: Database): GroupPlanRsvpStore {
  return {
    async coveringFamily(chatId) {
      const [family] = await database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(eq(schema.families.linqGroupChatId, chatId))
        .limit(1);
      if (!family) return null;
      const [host] = await database
        .select({ timezone: schema.users.timezone })
        .from(schema.familyMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
        .where(eq(schema.familyMembers.familyId, family.id))
        .limit(1);
      return { familyId: family.id, timeZone: host?.timezone?.trim() || 'America/Toronto' };
    },

    async loadLivePlan(chatId) {
      const [row] = await database
        .select()
        .from(schema.linqGroupPlans)
        .where(
          and(eq(schema.linqGroupPlans.chatId, chatId), isNull(schema.linqGroupPlans.closedAt)),
        )
        .limit(1);
      if (!row || row.chatId !== chatId) return null;
      return {
        id: row.id,
        chatId: row.chatId,
        familyId: row.familyId,
        title: row.title,
        startsAt: row.startsAt,
        location: row.location,
        rsvpDeadlineAt: row.rsvpDeadlineAt,
        expectedCount: row.expectedCount,
      };
    },

    async createPlan(input) {
      return database.transaction(async (tx) => {
        const [plan] = await tx
          .insert(schema.linqGroupPlans)
          .values({
            chatId: input.chatId,
            familyId: input.familyId,
            title: input.title,
            startsAt: input.startsAt,
            location: input.location,
            rsvpDeadlineAt: input.rsvpDeadlineAt,
            expectedCount: input.expected.length,
            createdByUserId: input.createdByUserId,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning();
        if (!plan) throw new Error('createPlan: linq_group_plans insert returned no row');
        if (input.expected.length > 0) {
          await tx.insert(schema.linqGroupPlanExpected).values(
            input.expected.map((person) => ({
              planId: plan.id,
              memberKey: person.memberKey,
              displayName: person.displayName,
              userId: person.userId,
              haleCustomer: flag(person.haleCustomer),
              createdAt: input.now,
            })),
          );
        }
        await tx.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: input.createdByUserId ?? 'system',
          actionTaken: 'linq_group_plan_started',
          targetTable: 'linq_group_plans',
          targetId: plan.id,
          after: { title: input.title, expected: input.expected.length },
        });
        return {
          id: plan.id,
          chatId: plan.chatId,
          familyId: plan.familyId,
          title: plan.title,
          startsAt: plan.startsAt,
          location: plan.location,
          rsvpDeadlineAt: plan.rsvpDeadlineAt,
          expectedCount: plan.expectedCount,
        };
      });
    },

    async loadTally(planId) {
      const rsvpRows = await database
        .select()
        .from(schema.linqGroupPlanRsvps)
        .where(eq(schema.linqGroupPlanRsvps.planId, planId));
      const expectedRows = await database
        .select()
        .from(schema.linqGroupPlanExpected)
        .where(eq(schema.linqGroupPlanExpected.planId, planId));
      const rows: PlanTallyRow[] = rsvpRows.map((row) => ({
        memberKey: row.memberKey,
        displayName: row.displayName,
        response: row.response as PlanRsvpResponse,
        headcount: row.headcount,
        householdLabel: row.householdLabel,
        coversKeys: parseCovers(row.coversKeys),
      }));
      const expected: PlanExpectedRow[] = expectedRows.map((row) => ({
        memberKey: row.memberKey,
        displayName: row.displayName,
      }));
      return { tally: tallyPlanRsvps(rows, expected), rows, expected };
    },

    async upsertRsvp(input) {
      const existing = await database
        .select({
          id: schema.linqGroupPlanRsvps.id,
          response: schema.linqGroupPlanRsvps.response,
          headcount: schema.linqGroupPlanRsvps.headcount,
        })
        .from(schema.linqGroupPlanRsvps)
        .where(
          and(
            eq(schema.linqGroupPlanRsvps.planId, input.planId),
            eq(schema.linqGroupPlanRsvps.memberKey, input.memberKey),
          ),
        )
        .limit(1);
      const prior = existing[0];
      const edited =
        !!prior && (prior.response !== input.response || prior.headcount !== input.headcount);

      await database.transaction(async (tx) => {
        const [plan] = await tx
          .select({ familyId: schema.linqGroupPlans.familyId })
          .from(schema.linqGroupPlans)
          .where(eq(schema.linqGroupPlans.id, input.planId))
          .limit(1);
        if (!plan) throw new Error('upsertRsvp: plan missing');
        await tx
          .insert(schema.linqGroupPlanRsvps)
          .values({
            planId: input.planId,
            memberKey: input.memberKey,
            displayName: input.displayName,
            householdLabel: input.householdLabel,
            userId: input.userId,
            haleCustomer: flag(input.haleCustomer),
            response: input.response,
            headcount: input.headcount,
            source: input.source,
            coversKeys: JSON.stringify([...input.coversKeys]),
            verbatim: input.verbatim,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [schema.linqGroupPlanRsvps.planId, schema.linqGroupPlanRsvps.memberKey],
            set: {
              displayName: input.displayName,
              householdLabel: input.householdLabel,
              response: input.response,
              headcount: input.headcount,
              source: input.source,
              coversKeys: JSON.stringify([...input.coversKeys]),
              verbatim: input.verbatim,
              updatedAt: input.now,
            },
          });
        await tx.insert(schema.auditLog).values({
          familyId: plan.familyId,
          actor: input.userId ?? 'system',
          actionTaken: edited ? 'linq_group_plan_rsvp_edited' : 'linq_group_plan_rsvp_recorded',
          targetTable: 'linq_group_plan_rsvps',
          targetId: input.planId,
          after: { response: input.response, headcount: input.headcount, edited },
        });
      });
      return { edited };
    },

    async addExpected(planId, person) {
      await database
        .insert(schema.linqGroupPlanExpected)
        .values({
          planId,
          memberKey: person.memberKey,
          displayName: person.displayName,
          userId: person.userId,
          haleCustomer: flag(person.haleCustomer),
        })
        .onConflictDoNothing();
      const expected = await database
        .select({ id: schema.linqGroupPlanExpected.id })
        .from(schema.linqGroupPlanExpected)
        .where(eq(schema.linqGroupPlanExpected.planId, planId));
      await database
        .update(schema.linqGroupPlans)
        .set({ expectedCount: expected.length })
        .where(eq(schema.linqGroupPlans.id, planId));
    },

    seatedExpected: (chatId) => postgresSeatedExpected(database, chatId),

    async claimFollowup(planId, wave, now) {
      const existing = await database
        .select({
          id: schema.linqGroupPlanFollowups.id,
          claimedAt: schema.linqGroupPlanFollowups.claimedAt,
          sentAt: schema.linqGroupPlanFollowups.sentAt,
        })
        .from(schema.linqGroupPlanFollowups)
        .where(
          and(
            eq(schema.linqGroupPlanFollowups.planId, planId),
            eq(schema.linqGroupPlanFollowups.wave, wave),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row?.sentAt || row?.claimedAt) return false;
      if (!row) {
        await database.insert(schema.linqGroupPlanFollowups).values({
          planId,
          wave,
          claimedAt: now,
        });
        return true;
      }
      const claimed = await database
        .update(schema.linqGroupPlanFollowups)
        .set({ claimedAt: now })
        .where(
          and(
            eq(schema.linqGroupPlanFollowups.id, row.id),
            isNull(schema.linqGroupPlanFollowups.claimedAt),
            isNull(schema.linqGroupPlanFollowups.sentAt),
          ),
        )
        .returning({ id: schema.linqGroupPlanFollowups.id });
      return claimed.length > 0;
    },

    async markFollowupSent(planId, wave, now) {
      await database
        .update(schema.linqGroupPlanFollowups)
        .set({ sentAt: now })
        .where(
          and(
            eq(schema.linqGroupPlanFollowups.planId, planId),
            eq(schema.linqGroupPlanFollowups.wave, wave),
          ),
        );
    },

    async releaseFollowup(planId, wave) {
      await database
        .update(schema.linqGroupPlanFollowups)
        .set({ claimedAt: null })
        .where(
          and(
            eq(schema.linqGroupPlanFollowups.planId, planId),
            eq(schema.linqGroupPlanFollowups.wave, wave),
            isNull(schema.linqGroupPlanFollowups.sentAt),
          ),
        );
    },

    async listDueFollowups(now) {
      const plans = await database
        .select()
        .from(schema.linqGroupPlans)
        .where(isNull(schema.linqGroupPlans.closedAt));
      const due: { plan: GroupPlanRecord; timeZone: string; waitingNames: string[] }[] = [];
      for (const row of plans) {
        if (row.rsvpDeadlineAt && row.rsvpDeadlineAt.getTime() > now.getTime()) continue;
        const { tally } = await this.loadTally(row.id);
        if (tally.toGo === 0) continue;
        const sent = await database
          .select({ sentAt: schema.linqGroupPlanFollowups.sentAt })
          .from(schema.linqGroupPlanFollowups)
          .where(
            and(
              eq(schema.linqGroupPlanFollowups.planId, row.id),
              eq(schema.linqGroupPlanFollowups.wave, 1),
            ),
          )
          .limit(1);
        if (sent[0]?.sentAt) continue;
        const cover = await this.coveringFamily(row.chatId);
        due.push({
          plan: {
            id: row.id,
            chatId: row.chatId,
            familyId: row.familyId,
            title: row.title,
            startsAt: row.startsAt,
            location: row.location,
            rsvpDeadlineAt: row.rsvpDeadlineAt,
            expectedCount: row.expectedCount,
          },
          timeZone: cover?.timeZone ?? 'America/Toronto',
          waitingNames: tally.waitingNames,
        });
      }
      return due;
    },
  };
}

export { memberKeyFromHandle, memberKeyFromName };
