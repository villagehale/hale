import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { readGroupMembership } from '../group-membership';
import { memberKeyFromHandle, memberKeyFromName } from './member-key';
import { type GroupPollStore, createPostgresGroupPollStore } from './poll-store';
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

export type CalendarConsentStatus = 'asked' | 'declined' | 'written';

export interface CalendarConsentRow {
  planId: string;
  familyId: string;
  memberKey: string;
  displayName: string;
  householdLabel: string | null;
  status: CalendarConsentStatus;
  familyEventId: string | null;
  askProviderMessageId: string | null;
}

export interface ClaimCalendarAskInput {
  planId: string;
  familyId: string;
  memberKey: string;
  displayName: string;
  householdLabel: string | null;
  now: Date;
}

/** Why an open calendar ask was dropped. The trail sentence is this fact, not a fixed cause. */
export const CALENDAR_WITHDRAW_REASONS = [
  'send_failed',
  'household_said_no',
  'household_said_maybe',
  'plan_changed',
] as const;
export type CalendarWithdrawReason = (typeof CALENDAR_WITHDRAW_REASONS)[number];

export interface GroupPlanRsvpStore extends GroupPollStore {
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
  loadCalendarConsent(planId: string, familyId: string): Promise<CalendarConsentRow | null>;
  /** Inserts `asked`. False when this household already has a row for the plan. */
  claimCalendarAsk(input: ClaimCalendarAskInput): Promise<boolean>;
  /** Drops an unanswered ask. Audits only when a row went, with the reason that happened. */
  releaseCalendarAsk(
    planId: string,
    familyId: string,
    actorUserId: string | null,
    reason: CalendarWithdrawReason,
  ): Promise<boolean>;
  listYesRsvps(planId: string): Promise<{ memberKey: string; userId: string | null }[]>;
  setCalendarAskMessage(planId: string, familyId: string, providerMessageId: string): Promise<void>;
  findCalendarAskByMessage(
    providerMessageId: string,
  ): Promise<{ plan: GroupPlanRecord; consent: CalendarConsentRow } | null>;
  listOpenCalendarAsks(
    userId: string,
  ): Promise<{ plan: GroupPlanRecord; consent: CalendarConsentRow }[]>;
  /** Drops a declined or written row so a later yes, or a reopen, can ask again. */
  deleteCalendarConsent(
    planId: string,
    familyId: string,
    status: CalendarConsentStatus,
  ): Promise<boolean>;
  /** Puts a decline back when a reopen ask could not be sent. */
  recordCalendarDecline(input: {
    planId: string;
    familyId: string;
    memberKey: string;
    displayName: string;
    householdLabel: string | null;
    actorUserId: string | null;
    now: Date;
  }): Promise<void>;
  noteCalendarRemoved(input: {
    planId: string;
    familyId: string;
    familyEventId: string;
    actorUserId: string | null;
  }): Promise<void>;
  noteCalendarAsked(input: {
    planId: string;
    familyId: string;
    actorUserId: string | null;
  }): Promise<void>;
  markCalendarDeclined(input: {
    planId: string;
    familyId: string;
    actorUserId: string | null;
    now: Date;
  }): Promise<void>;
  markCalendarWritten(input: {
    planId: string;
    familyId: string;
    familyEventId: string;
    actorUserId: string | null;
    now: Date;
  }): Promise<void>;
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

/** Chats this person was removed from and has not rejoined. */
async function removedSeatChatIds(
  database: Database,
  userId: string,
  live: Set<string>,
): Promise<Set<string>> {
  const rows = await database
    .select({ chatId: schema.linqGroupMembers.chatId })
    .from(schema.linqGroupMembers)
    .where(
      and(eq(schema.linqGroupMembers.userId, userId), isNotNull(schema.linqGroupMembers.removedAt)),
    );
  const shared = await database
    .select({ chatId: schema.linqMultiFamilyMembers.chatId })
    .from(schema.linqMultiFamilyMembers)
    .where(
      and(
        eq(schema.linqMultiFamilyMembers.userId, userId),
        isNotNull(schema.linqMultiFamilyMembers.removedAt),
      ),
    );
  const removed = new Set([...rows, ...shared].map((row) => row.chatId));
  for (const chatId of live) removed.delete(chatId);
  return removed;
}

/** Chats where this person still has a seat. A removed seat is not current. */
async function liveSeatChatIds(database: Database, userId: string): Promise<Set<string>> {
  const groupSeats = await database
    .select({ chatId: schema.linqGroupMembers.chatId })
    .from(schema.linqGroupMembers)
    .where(
      and(eq(schema.linqGroupMembers.userId, userId), isNull(schema.linqGroupMembers.removedAt)),
    );
  const sharedSeats = await database
    .select({ chatId: schema.linqMultiFamilyMembers.chatId })
    .from(schema.linqMultiFamilyMembers)
    .where(
      and(
        eq(schema.linqMultiFamilyMembers.userId, userId),
        isNull(schema.linqMultiFamilyMembers.removedAt),
      ),
    );
  return new Set([...groupSeats, ...sharedSeats].map((row) => row.chatId));
}

export function createPostgresGroupPlanRsvpStore(database: Database): GroupPlanRsvpStore {
  return {
    ...createPostgresGroupPollStore(database),

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

    async loadCalendarConsent(planId, familyId) {
      const [row] = await database
        .select()
        .from(schema.linqGroupPlanCalendarConsents)
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, familyId),
          ),
        )
        .limit(1);
      if (!row || row.familyId !== familyId) return null;
      return {
        planId: row.planId,
        familyId: row.familyId,
        memberKey: row.memberKey,
        displayName: row.displayName,
        householdLabel: row.householdLabel,
        status: row.status as CalendarConsentStatus,
        familyEventId: row.familyEventId,
        askProviderMessageId: row.askProviderMessageId,
      };
    },

    async claimCalendarAsk(input) {
      const inserted = await database
        .insert(schema.linqGroupPlanCalendarConsents)
        .values({
          planId: input.planId,
          familyId: input.familyId,
          memberKey: input.memberKey,
          displayName: input.displayName,
          householdLabel: input.householdLabel,
          status: 'asked',
          askedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            schema.linqGroupPlanCalendarConsents.planId,
            schema.linqGroupPlanCalendarConsents.familyId,
          ],
        })
        .returning({ id: schema.linqGroupPlanCalendarConsents.id });
      return inserted.length > 0;
    },

    async releaseCalendarAsk(planId, familyId, actorUserId, reason) {
      const deleted = await database
        .delete(schema.linqGroupPlanCalendarConsents)
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, familyId),
            eq(schema.linqGroupPlanCalendarConsents.status, 'asked'),
          ),
        )
        .returning({ id: schema.linqGroupPlanCalendarConsents.id });
      if (deleted.length === 0) return false;
      await database.insert(schema.auditLog).values({
        familyId,
        actor: actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_withdrawn',
        targetTable: 'linq_group_plan_calendar_consents',
        targetId: planId,
        after: { familyId, reason },
      });
      return true;
    },

    async listYesRsvps(planId) {
      const rows = await database
        .select({
          memberKey: schema.linqGroupPlanRsvps.memberKey,
          userId: schema.linqGroupPlanRsvps.userId,
          response: schema.linqGroupPlanRsvps.response,
        })
        .from(schema.linqGroupPlanRsvps)
        .where(eq(schema.linqGroupPlanRsvps.planId, planId));
      return rows
        .filter((row) => row.response === 'yes')
        .map((row) => ({ memberKey: row.memberKey, userId: row.userId }));
    },

    async setCalendarAskMessage(planId, familyId, providerMessageId) {
      await database
        .update(schema.linqGroupPlanCalendarConsents)
        .set({ askProviderMessageId: providerMessageId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, familyId),
          ),
        );
    },

    async findCalendarAskByMessage(providerMessageId) {
      const [row] = await database
        .select()
        .from(schema.linqGroupPlanCalendarConsents)
        .where(eq(schema.linqGroupPlanCalendarConsents.askProviderMessageId, providerMessageId))
        .limit(1);
      if (!row || row.status !== 'asked') return null;
      const [plan] = await database
        .select()
        .from(schema.linqGroupPlans)
        .where(eq(schema.linqGroupPlans.id, row.planId))
        .limit(1);
      if (!plan || plan.closedAt) return null;
      return {
        plan: {
          id: plan.id,
          chatId: plan.chatId,
          familyId: plan.familyId,
          title: plan.title,
          startsAt: plan.startsAt,
          location: plan.location,
          rsvpDeadlineAt: plan.rsvpDeadlineAt,
          expectedCount: plan.expectedCount,
        },
        consent: {
          planId: row.planId,
          familyId: row.familyId,
          memberKey: row.memberKey,
          displayName: row.displayName,
          householdLabel: row.householdLabel,
          status: 'asked',
          familyEventId: row.familyEventId,
          askProviderMessageId: row.askProviderMessageId,
        },
      };
    },

    async listOpenCalendarAsks(userId) {
      const memberships = await database
        .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.userId, userId));
      const families = memberships
        .filter((row) => row.role === 'primary_parent' || row.role === 'co_parent')
        .map((row) => row.familyId);
      if (families.length === 0) return [];
      const seated = await liveSeatChatIds(database, userId);
      const removed = await removedSeatChatIds(database, userId, seated);
      const mine = await database
        .select()
        .from(schema.linqGroupPlanCalendarConsents)
        .where(
          and(
            inArray(schema.linqGroupPlanCalendarConsents.status, ['asked', 'declined']),
            inArray(schema.linqGroupPlanCalendarConsents.familyId, families),
          ),
        );
      const out: { plan: GroupPlanRecord; consent: CalendarConsentRow }[] = [];
      for (const row of mine) {
        const [plan] = await database
          .select()
          .from(schema.linqGroupPlans)
          .where(eq(schema.linqGroupPlans.id, row.planId))
          .limit(1);
        if (!plan || plan.closedAt) continue;
        const [cover] = await database
          .select({ id: schema.families.id })
          .from(schema.families)
          .where(eq(schema.families.linqGroupChatId, plan.chatId))
          .limit(1);
        const claimed =
          cover?.id === row.familyId &&
          !removed.has(plan.chatId) &&
          families.includes(row.familyId);
        if (!seated.has(plan.chatId) && !claimed) continue;
        out.push({
          plan: {
            id: plan.id,
            chatId: plan.chatId,
            familyId: plan.familyId,
            title: plan.title,
            startsAt: plan.startsAt,
            location: plan.location,
            rsvpDeadlineAt: plan.rsvpDeadlineAt,
            expectedCount: plan.expectedCount,
          },
          consent: {
            planId: row.planId,
            familyId: row.familyId,
            memberKey: row.memberKey,
            displayName: row.displayName,
            householdLabel: row.householdLabel,
            status: row.status === 'declined' ? 'declined' : 'asked',
            familyEventId: row.familyEventId,
            askProviderMessageId: row.askProviderMessageId,
          },
        });
      }
      return out;
    },

    async deleteCalendarConsent(planId, familyId, status) {
      const deleted = await database
        .delete(schema.linqGroupPlanCalendarConsents)
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, familyId),
            eq(schema.linqGroupPlanCalendarConsents.status, status),
          ),
        )
        .returning({ id: schema.linqGroupPlanCalendarConsents.id });
      return deleted.length > 0;
    },

    async recordCalendarDecline(input) {
      await database
        .insert(schema.linqGroupPlanCalendarConsents)
        .values({
          planId: input.planId,
          familyId: input.familyId,
          memberKey: input.memberKey,
          displayName: input.displayName,
          householdLabel: input.householdLabel,
          status: 'declined',
          decidedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            schema.linqGroupPlanCalendarConsents.planId,
            schema.linqGroupPlanCalendarConsents.familyId,
          ],
        });
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_declined',
        targetTable: 'linq_group_plan_calendar_consents',
        targetId: input.planId,
        after: { familyId: input.familyId, restored: true },
      });
    },

    async noteCalendarRemoved(input) {
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_removed',
        targetTable: 'family_events',
        targetId: input.familyEventId,
        after: { familyId: input.familyId },
      });
    },

    async noteCalendarAsked(input) {
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_asked',
        targetTable: 'linq_group_plan_calendar_consents',
        targetId: input.planId,
        after: { familyId: input.familyId },
      });
    },

    async markCalendarDeclined(input) {
      await database
        .update(schema.linqGroupPlanCalendarConsents)
        .set({ status: 'declined', decidedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, input.planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, input.familyId),
            eq(schema.linqGroupPlanCalendarConsents.status, 'asked'),
          ),
        );
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_declined',
        targetTable: 'linq_group_plan_calendar_consents',
        targetId: input.planId,
        after: { familyId: input.familyId },
      });
    },

    async markCalendarWritten(input) {
      await database
        .update(schema.linqGroupPlanCalendarConsents)
        .set({
          status: 'written',
          familyEventId: input.familyEventId,
          decidedAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, input.planId),
            eq(schema.linqGroupPlanCalendarConsents.familyId, input.familyId),
          ),
        );
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_calendar_written',
        targetTable: 'family_events',
        targetId: input.familyEventId,
        after: { familyId: input.familyId },
      });
    },
  };
}

export { memberKeyFromHandle, memberKeyFromName };
