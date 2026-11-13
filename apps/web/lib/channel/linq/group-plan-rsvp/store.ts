import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, inArray, isNull, lt, notExists, sql } from 'drizzle-orm';
import { noteTaskCompleted } from '~/lib/analytics/product-hooks';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { readGroupMembership } from '../group-membership';
import { postgresGroupPlanHouseholds } from './calendar';
import { memberKeyFromHandle, memberKeyFromName } from './member-key';
import { planIdOfGroupLine } from './plan-identity';
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
  /** An open plan in this chat the new event replaces, by id: it closes as superseded. */
  replacesPlanId?: string | null;
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

/**
 * How long after its start a plan stays open. Past this, the event is over: the next read
 * closes it, so a later RSVP, poll or lock in the chat never lands on it.
 */
export const GROUP_PLAN_PAST_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * How long a plan with no time stays open with nobody touching it (no answer, no new time). A
 * plan with no time is never known to be ahead, so a new event leaves it open; past this it is
 * stale, and the next read closes it rather than keep showing it to the reader.
 */
export const GROUP_PLAN_UNTIMED_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Why a plan closed: its start passed, a plan with no time sat untouched, or a new event in the
 * same chat replaced it by id.
 */
export type GroupPlanCloseReason = 'past' | 'idle' | 'superseded';

/** The audit verb a moved calendar copy writes; the held notice re-drive reads it back. */
export const GROUP_PLAN_CALENDAR_MOVED_VERB = 'linq_group_plan_calendar_moved';

export interface GroupPlanRsvpStore extends GroupPollStore {
  coveringFamily(chatId: string): Promise<{ familyId: string; timeZone: string } | null>;
  /**
   * The chat's open plans, newest first, closing (and auditing) any whose start has passed.
   * A message binds to one of them only by its id: never by being the only one, or the newest.
   */
  listOpenPlans(chatId: string, now: Date): Promise<GroupPlanRecord[]>;
  /** This plan while it is open in this chat (a past one closes here first), else null. */
  loadOpenPlan(chatId: string, planId: string, now: Date): Promise<GroupPlanRecord | null>;
  /**
   * Opens a plan. Other open plans stay open; only `replacesPlanId`, an open plan in the same
   * chat, closes as superseded in the same step.
   */
  createPlan(input: CreatePlanInput): Promise<GroupPlanRecord>;
  /** The plan a Hale group line (by its provider message id) in this chat was about, or null. */
  planOfGroupLine(
    chatId: string,
    providerMessageId: string,
    templateKeys: readonly string[],
  ): Promise<string | null>;
  /** Moves an open plan's start. False when the plan is closed (nothing moves). */
  setPlanStart(
    planId: string,
    startsAt: Date,
    actorUserId: string | null,
    now: Date,
  ): Promise<boolean>;
  /** Households whose copy of this plan Hale wrote to their calendar. */
  listWrittenCalendarConsents(planId: string): Promise<CalendarConsentRow[]>;
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
  /** The household's own zone, or null when Hale does not know it. Never a product default. */
  householdTimeZone(familyId: string): Promise<string | null>;
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
  /** A written copy now carries the plan's new time. Returns the audit row id: the notice's key. */
  noteCalendarMoved(input: {
    planId: string;
    familyId: string;
    familyEventId: string;
    startsAt: Date;
    actorUserId: string | null;
  }): Promise<string>;
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

function consentRow(
  row: typeof schema.linqGroupPlanCalendarConsents.$inferSelect,
): CalendarConsentRow {
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
}

function planClosedAudit(plan: { id: string; familyId: string }, reason: GroupPlanCloseReason) {
  return {
    familyId: plan.familyId,
    actor: 'system',
    actionTaken: 'linq_group_plan_closed',
    targetTable: 'linq_group_plans',
    targetId: plan.id,
    after: { reason },
  };
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

function planRecord(row: typeof schema.linqGroupPlans.$inferSelect): GroupPlanRecord {
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
}

async function closePastPlans(database: Database, chatId: string, now: Date): Promise<void> {
  const pastBefore = new Date(now.getTime() - GROUP_PLAN_PAST_AFTER_MS);
  const past = await database
    .update(schema.linqGroupPlans)
    .set({ closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.linqGroupPlans.chatId, chatId),
        isNull(schema.linqGroupPlans.closedAt),
        lt(schema.linqGroupPlans.startsAt, pastBefore),
      ),
    )
    .returning({ id: schema.linqGroupPlans.id, familyId: schema.linqGroupPlans.familyId });
  for (const plan of past) {
    await database.insert(schema.auditLog).values(planClosedAudit(plan, 'past'));
  }
  const idleBefore = new Date(now.getTime() - GROUP_PLAN_UNTIMED_IDLE_MS);
  const idle = await database
    .update(schema.linqGroupPlans)
    .set({ closedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.linqGroupPlans.chatId, chatId),
        isNull(schema.linqGroupPlans.closedAt),
        isNull(schema.linqGroupPlans.startsAt),
        lt(schema.linqGroupPlans.updatedAt, idleBefore),
        notExists(
          database
            .select({ one: sql`1` })
            .from(schema.linqGroupPlanRsvps)
            .where(
              and(
                eq(schema.linqGroupPlanRsvps.planId, schema.linqGroupPlans.id),
                gte(schema.linqGroupPlanRsvps.updatedAt, idleBefore),
              ),
            ),
        ),
      ),
    )
    .returning({ id: schema.linqGroupPlans.id, familyId: schema.linqGroupPlans.familyId });
  for (const plan of idle) {
    await database.insert(schema.auditLog).values(planClosedAudit(plan, 'idle'));
  }
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

    async listOpenPlans(chatId, now) {
      await closePastPlans(database, chatId, now);
      const rows = await database
        .select()
        .from(schema.linqGroupPlans)
        .where(
          and(eq(schema.linqGroupPlans.chatId, chatId), isNull(schema.linqGroupPlans.closedAt)),
        )
        .orderBy(desc(schema.linqGroupPlans.createdAt));
      return rows.filter((row) => row.chatId === chatId).map(planRecord);
    },

    async loadOpenPlan(chatId, planId, now) {
      await closePastPlans(database, chatId, now);
      const [row] = await database
        .select()
        .from(schema.linqGroupPlans)
        .where(
          and(
            eq(schema.linqGroupPlans.id, planId),
            eq(schema.linqGroupPlans.chatId, chatId),
            isNull(schema.linqGroupPlans.closedAt),
          ),
        )
        .limit(1);
      return row && row.chatId === chatId ? planRecord(row) : null;
    },

    async createPlan(input) {
      return database.transaction(async (tx) => {
        const superseded = input.replacesPlanId
          ? await tx
              .update(schema.linqGroupPlans)
              .set({ closedAt: input.now, updatedAt: input.now })
              .where(
                and(
                  eq(schema.linqGroupPlans.id, input.replacesPlanId),
                  eq(schema.linqGroupPlans.chatId, input.chatId),
                  isNull(schema.linqGroupPlans.closedAt),
                ),
              )
              .returning({
                id: schema.linqGroupPlans.id,
                familyId: schema.linqGroupPlans.familyId,
              })
          : [];
        for (const old of superseded) {
          await tx.insert(schema.auditLog).values(planClosedAudit(old, 'superseded'));
        }
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

    async planOfGroupLine(chatId, providerMessageId, templateKeys) {
      return planIdOfGroupLine(database, { chatId, providerMessageId, templateKeys });
    },

    async setPlanStart(planId, startsAt, actorUserId, now) {
      const [moved] = await database
        .update(schema.linqGroupPlans)
        .set({ startsAt, updatedAt: now })
        .where(and(eq(schema.linqGroupPlans.id, planId), isNull(schema.linqGroupPlans.closedAt)))
        .returning({ id: schema.linqGroupPlans.id, familyId: schema.linqGroupPlans.familyId });
      if (!moved) return false;
      await database.insert(schema.auditLog).values({
        familyId: moved.familyId,
        actor: actorUserId ?? 'system',
        actionTaken: 'linq_group_plan_time_set',
        targetTable: 'linq_group_plans',
        targetId: moved.id,
        after: { startsAt: startsAt.toISOString() },
      });
      return true;
    },

    async listWrittenCalendarConsents(planId) {
      const rows = await database
        .select()
        .from(schema.linqGroupPlanCalendarConsents)
        .where(
          and(
            eq(schema.linqGroupPlanCalendarConsents.planId, planId),
            eq(schema.linqGroupPlanCalendarConsents.status, 'written'),
          ),
        );
      return rows.map(consentRow);
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
        if (!prior) {
          noteTaskCompleted({ familyId: plan.familyId, type: 'rsvp', source: 'group' });
        }
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
          timeZone: (await this.householdTimeZone(row.familyId)) ?? 'America/Toronto',
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
      return consentRow(row);
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
      const homes = postgresGroupPlanHouseholds(database);
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
        // The same rule the answer uses: this sender's seat in the chat must
        // resolve to this row's household, never just to some seat in the chat.
        const home = await homes.resolve({ chatId: plan.chatId, userId });
        if (home.status !== 'one' || home.familyId !== row.familyId) continue;
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

    async householdTimeZone(familyId) {
      return knownHouseholdTimezone(database, familyId);
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

    async noteCalendarMoved(input) {
      const [row] = await database
        .insert(schema.auditLog)
        .values({
          familyId: input.familyId,
          actor: input.actorUserId ?? 'system',
          actionTaken: GROUP_PLAN_CALENDAR_MOVED_VERB,
          targetTable: 'linq_group_plans',
          targetId: input.planId,
          after: { familyEventId: input.familyEventId, startsAt: input.startsAt.toISOString() },
        })
        .returning({ id: schema.auditLog.id });
      if (!row) throw new Error('noteCalendarMoved: audit_log insert returned no row');
      return row.id;
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
