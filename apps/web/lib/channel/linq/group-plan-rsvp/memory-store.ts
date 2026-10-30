import { randomUUID } from 'node:crypto';
import type { GroupPollRecord, GroupPollStore, NativeCardOption } from './poll-store';
import { pollOptionsFrom, withCardIds } from './poll-store';
import { tallyGroupPoll } from './poll-tally';
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

interface MemoryPoll extends GroupPollRecord {
  votes: Map<string, { memberKey: string; displayName: string; optionKey: string; source: string }>;
  closedAt: Date | null;
}

export interface MemoryGroupPlanWorld {
  families: Map<string, { familyId: string; timeZone: string }>;
  seats: Map<string, ExpectedPerson[]>;
  plans: Map<string, MemoryPlan>;
  polls: Map<string, MemoryPoll>;
  /** Native poll cards Hale sent, keyed by Linq's poll message id. */
  cards: Map<string, NativeCardOption[]>;
  audits: { actionTaken: string; after: Record<string, unknown> }[];
}

export function createMemoryWorld(): MemoryGroupPlanWorld {
  return {
    families: new Map(),
    seats: new Map(),
    plans: new Map(),
    polls: new Map(),
    cards: new Map(),
    audits: [],
  };
}

function copyPoll(poll: MemoryPoll): GroupPollRecord {
  return {
    id: poll.id,
    chatId: poll.chatId,
    familyId: poll.familyId,
    question: poll.question,
    options: poll.options.map((option) => ({ ...option })),
    expected: poll.expected.map((person) => ({ ...person })),
    providerMessageId: poll.providerMessageId,
    origin: poll.origin,
  };
}

export function createMemoryGroupPollStore(world: MemoryGroupPlanWorld): GroupPollStore {
  const live = (chatId: string) =>
    [...world.polls.values()].find((poll) => poll.chatId === chatId && poll.closedAt === null);
  return {
    async loadLivePoll(chatId) {
      const poll = live(chatId);
      return poll ? copyPoll(poll) : null;
    },

    async pollForCard(chatId, providerMessageId) {
      const poll = live(chatId);
      return poll && poll.providerMessageId === providerMessageId ? copyPoll(poll) : null;
    },

    async createPoll(input) {
      const prior = live(input.chatId);
      if (prior) prior.closedAt = input.now;
      const poll: MemoryPoll = {
        id: randomUUID(),
        chatId: input.chatId,
        familyId: input.familyId,
        question: input.question,
        options: pollOptionsFrom(input.options),
        expected: input.expected.map((person) => ({ ...person })),
        providerMessageId: input.providerMessageId,
        origin: input.origin,
        votes: new Map(),
        closedAt: null,
      };
      world.polls.set(poll.id, poll);
      world.audits.push({
        actionTaken: 'linq_group_poll_started',
        after: {
          origin: input.origin,
          options: input.options.length,
          expected: input.expected.length,
        },
      });
      return copyPoll(poll);
    },

    async attachCard(pollId, card) {
      const poll = world.polls.get(pollId);
      if (!poll) return;
      poll.providerMessageId = card.providerMessageId;
      poll.options = withCardIds(poll.options, card.options);
    },

    async cardOptions(providerMessageId) {
      return [...(world.cards.get(providerMessageId) ?? [])];
    },

    async loadPollTally(pollId) {
      const poll = world.polls.get(pollId);
      if (!poll) return tallyGroupPoll([], [], []);
      return tallyGroupPoll(poll.options, [...poll.votes.values()], poll.expected);
    },

    async recordPollVote(input) {
      const poll = world.polls.get(input.pollId);
      if (!poll) throw new Error('recordPollVote: poll missing');
      const prior = poll.votes.get(input.memberKey);
      if (prior?.optionKey === input.optionKey) return { changed: false };
      poll.votes.set(input.memberKey, {
        memberKey: input.memberKey,
        displayName: input.displayName,
        optionKey: input.optionKey,
        source: input.source,
      });
      world.audits.push({
        actionTaken: 'linq_group_poll_vote_recorded',
        after: { source: input.source, changed: Boolean(prior) },
      });
      return { changed: true };
    },

    async clearPollVote(input) {
      const poll = world.polls.get(input.pollId);
      const prior = poll?.votes.get(input.memberKey);
      if (!poll || prior?.optionKey !== input.optionKey) return { cleared: false };
      poll.votes.delete(input.memberKey);
      world.audits.push({
        actionTaken: 'linq_group_poll_vote_removed',
        after: { source: 'native' },
      });
      return { cleared: true };
    },
  };
}

export function createMemoryGroupPlanRsvpStore(world: MemoryGroupPlanWorld): GroupPlanRsvpStore {
  const plansById = () => [...world.plans.values()];

  return {
    ...createMemoryGroupPollStore(world),

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
