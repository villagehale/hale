import { randomUUID } from 'node:crypto';
import type {
  CreatePlanInput,
  ExpectedPerson,
  GroupPlanRecord,
  GroupPlanRsvpStore,
  UpsertRsvpInput,
} from './store';
import {
  type PlanExpectedRow,
  type PlanRsvpResponse,
  type PlanTallyRow,
  tallyPlanRsvps,
} from './tally';

/**
 * In-process store for Preview fake-family conversations and unit tests.
 * Same contract as the Postgres store. No network. No real families.
 */

interface MemoryRsvp {
  memberKey: string;
  displayName: string;
  householdLabel: string | null;
  userId: string | null;
  haleCustomer: boolean;
  response: PlanRsvpResponse;
  headcount: number;
  source: UpsertRsvpInput['source'];
  coversKeys: string[];
  verbatim: string | null;
}

interface MemoryFollowup {
  wave: number;
  claimedAt: Date | null;
  sentAt: Date | null;
}

interface MemoryPlan extends GroupPlanRecord {
  expected: ExpectedPerson[];
  rsvps: Map<string, MemoryRsvp>;
  followups: MemoryFollowup[];
  closedAt: Date | null;
}

export interface MemoryGroupPlanWorld {
  families: Map<string, { familyId: string; timeZone: string }>;
  seats: Map<string, ExpectedPerson[]>;
  plans: Map<string, MemoryPlan>;
  audits: { actionTaken: string; after: Record<string, unknown> }[];
}

export function createMemoryWorld(): MemoryGroupPlanWorld {
  return {
    families: new Map(),
    seats: new Map(),
    plans: new Map(),
    audits: [],
  };
}

export function createMemoryGroupPlanRsvpStore(world: MemoryGroupPlanWorld): GroupPlanRsvpStore {
  const plansById = () => [...world.plans.values()];

  return {
    async coveringFamily(chatId) {
      return world.families.get(chatId) ?? null;
    },

    async loadLivePlan(chatId) {
      const plan = plansById().find((row) => row.chatId === chatId && row.closedAt === null);
      return plan ? { ...plan } : null;
    },

    async createPlan(input: CreatePlanInput) {
      const plan: MemoryPlan = {
        id: randomUUID(),
        chatId: input.chatId,
        familyId: input.familyId,
        title: input.title,
        startsAt: input.startsAt,
        location: input.location,
        rsvpDeadlineAt: input.rsvpDeadlineAt,
        expectedCount: input.expected.length,
        expected: [...input.expected],
        rsvps: new Map(),
        followups: [],
        closedAt: null,
      };
      world.plans.set(plan.id, plan);
      world.audits.push({
        actionTaken: 'linq_group_plan_started',
        after: { title: input.title, expected: input.expected.length },
      });
      return { ...plan };
    },

    async loadTally(planId) {
      const plan = world.plans.get(planId);
      if (!plan) return { tally: tallyPlanRsvps([], []), rows: [], expected: [] };
      const rows: PlanTallyRow[] = [...plan.rsvps.values()].map((row) => ({
        memberKey: row.memberKey,
        displayName: row.displayName,
        response: row.response,
        headcount: row.headcount,
        householdLabel: row.householdLabel,
        coversKeys: row.coversKeys,
      }));
      const expected: PlanExpectedRow[] = plan.expected.map((person) => ({
        memberKey: person.memberKey,
        displayName: person.displayName,
      }));
      return { tally: tallyPlanRsvps(rows, expected), rows, expected };
    },

    async upsertRsvp(input) {
      const plan = world.plans.get(input.planId);
      if (!plan) throw new Error('upsertRsvp: plan missing');
      const prior = plan.rsvps.get(input.memberKey);
      const edited =
        !!prior && (prior.response !== input.response || prior.headcount !== input.headcount);
      plan.rsvps.set(input.memberKey, {
        memberKey: input.memberKey,
        displayName: input.displayName,
        householdLabel: input.householdLabel,
        userId: input.userId,
        haleCustomer: input.haleCustomer,
        response: input.response,
        headcount: input.headcount,
        source: input.source,
        coversKeys: [...input.coversKeys],
        verbatim: input.verbatim,
      });
      world.audits.push({
        actionTaken: edited ? 'linq_group_plan_rsvp_edited' : 'linq_group_plan_rsvp_recorded',
        after: { response: input.response, headcount: input.headcount, edited },
      });
      return { edited };
    },

    async addExpected(planId, person) {
      const plan = world.plans.get(planId);
      if (!plan) return;
      if (plan.expected.some((row) => row.memberKey === person.memberKey)) return;
      plan.expected.push(person);
      plan.expectedCount = plan.expected.length;
    },

    async seatedExpected(chatId) {
      return [...(world.seats.get(chatId) ?? [])];
    },

    async claimFollowup(planId, wave, now) {
      const plan = world.plans.get(planId);
      if (!plan) return false;
      const existing = plan.followups.find((row) => row.wave === wave);
      if (existing?.sentAt || existing?.claimedAt) return false;
      if (!existing) {
        plan.followups.push({ wave, claimedAt: now, sentAt: null });
        return true;
      }
      existing.claimedAt = now;
      return true;
    },

    async markFollowupSent(planId, wave, now) {
      const plan = world.plans.get(planId);
      const row = plan?.followups.find((item) => item.wave === wave);
      if (row) row.sentAt = now;
    },

    async releaseFollowup(planId, wave) {
      const plan = world.plans.get(planId);
      const row = plan?.followups.find((item) => item.wave === wave);
      if (row && !row.sentAt) row.claimedAt = null;
    },

    async listDueFollowups(now) {
      const due: { plan: GroupPlanRecord; timeZone: string; waitingNames: string[] }[] = [];
      for (const plan of plansById()) {
        if (plan.closedAt) continue;
        if (plan.rsvpDeadlineAt && plan.rsvpDeadlineAt.getTime() > now.getTime()) continue;
        const { tally } = await this.loadTally(plan.id);
        if (tally.toGo === 0) continue;
        if (plan.followups.some((row) => row.wave === 1 && row.sentAt)) continue;
        const cover = world.families.get(plan.chatId);
        due.push({
          plan: { ...plan },
          timeZone: cover?.timeZone ?? 'America/Toronto',
          waitingNames: tally.waitingNames,
        });
      }
      return due;
    },
  };
}
