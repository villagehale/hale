import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { PrivateAsideModel } from '../group-private-aside';
import type { GroupPlanRsvpReading } from '../group-plan-rsvp/reading';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import { handleLinqGroupMessage } from '../inbound';
import type { SharedGroupReader } from '../shared-group-reading';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import type { GroupExperienceReading } from './reading';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-689 gate (6f090a83) · the VIL-442 reader runs first in the group door, so the plan
 * binding and the lock have to hold on its path, not only on VIL-399's. The readings here
 * are what the production reader returns for these messages (recorded in
 * group-plan-rsvp-eval and group-poll-eval).
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-first-reader';
// 16:00Z is 11:00 in Toronto: daytime for every household here.
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const FROM = '+15555550100';
const SATURDAY_10 = '2026-11-14T10:00:00-05:00';
const SUNDAY_14 = '2026-11-15T14:00:00-05:00';

let db: TestDb;
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  for (const flag of [
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'LINQ_GROUP_ONBOARDING_V2_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
    'GROUP_MAIL_NOTICE_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED',
    'LINQ_GROUP_POLLS_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
  vi.stubEnv('LINQ_POLLS', 'on');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, linq_group_polls, audit_log, channel_messages cascade',
  );
});

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId: CHAT,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    userId,
    firstName: name,
  });
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId, joinedByUserId: userId, joinedAt: NOW });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'parent',
  });
  return { familyId, userId };
}

const sharedReader: SharedGroupReader = {
  async read() {
    return {
      intent: 'question',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
    };
  },
};
const noAside: PrivateAsideModel = {
  async read() {
    return [];
  },
  async draft() {
    return { send: false, about: '', text: '' };
  },
};
const none: GroupExperienceReading = {
  kind: 'none',
  title: null,
  samePlan: null,
  response: null,
  optionKey: null,
  options: [],
  starts: [],
  confidence: 'high',
};

function rsvpReading(partial: Partial<GroupPlanRsvpReading>): GroupPlanRsvpReading {
  return {
    intent: 'chatter',
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response: null,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
    samePlan: null,
    pollQuestion: null,
    pollOptions: [],
    pollChoice: null,
    ...partial,
  };
}

function door(input: {
  group: string[];
  dms: string[];
  rsvp: GroupPlanRsvpReading;
  experienceReads?: { count: number };
  experience?: GroupExperienceReading;
  rsvpInputs?: unknown[];
}) {
  return {
    database: db.database,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    enqueue: async () => {},
    now: () => NOW,
    sendGroupText: async ({ text }: { text: string }) => {
      input.group.push(text);
      return { providerMessageId: `g-${input.group.length}` };
    },
    oneToOne: {
      text: async ({ body }: { to: string; body: string }) => {
        input.dms.push(body);
        return { providerMessageId: `dm-${input.dms.length}`, chatId: `dm-${input.dms.length}` };
      },
      link: async () => ({ providerMessageId: 'unused' }),
    },
    listChatHandles: async () => ({ status: 'ok', handles: [PARENT_A, PARENT_B] }),
    sharedGroupReader: sharedReader,
    sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
    privateAsideModel: noAside,
    groupPlanRsvpReader: {
      read: async (readInput: unknown) => {
        input.rsvpInputs?.push(readInput);
        return input.rsvp;
      },
    },
    groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
    groupExperienceReader: {
      read: async () => {
        if (input.experienceReads) input.experienceReads.count += 1;
        return input.experience ?? none;
      },
    },
    groupExperienceComposer: fakeGroupExperienceComposer({
      body: (line) => `${line.kind} ${JSON.stringify(line.facts)}`,
    }),
  } as unknown as Parameters<typeof handleLinqGroupMessage>[0];
}

async function send(
  deps: Parameters<typeof handleLinqGroupMessage>[0],
  from: string,
  id: string,
  text: string,
): Promise<Record<string, unknown>> {
  const response = await handleLinqGroupMessage(deps, {
    messageId: id,
    chatId: CHAT,
    senderHandle: from,
    text,
    mediaCount: 0,
    receivedAt: NOW,
    otherHandles: [from === PARENT_A ? PARENT_B : PARENT_A],
    mentions: [],
    isGroup: true,
  } as unknown as Parameters<typeof handleLinqGroupMessage>[1]);
  return (await response.json()) as Record<string, unknown>;
}

async function openPicnic(familyId: string, userId: string) {
  return createPostgresGroupPlanRsvpStore(db.database).createPlan({
    chatId: CHAT,
    familyId,
    title: 'picnic',
    startsAt: new Date(SATURDAY_10),
    location: null,
    rsvpDeadlineAt: null,
    createdByUserId: userId,
    expected: [],
    now: NOW,
  });
}

describe('the first reader binds a plan opening to the plan it is about (gate REFUTED 1)', () => {
  it('"who is in for the zoo" with a picnic open opens a zoo plan, closes the picnic, and asks about the zoo', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const group: string[] = [];
    const dms: string[] = [];

    await send(
      door({
        group,
        dms,
        rsvp: rsvpReading({
          intent: 'start_tracking',
          planTitle: 'zoo',
          startsAt: SUNDAY_14,
          samePlan: false,
        }),
      }),
      PARENT_A,
      'm1',
      "Hale who's in for the zoo Sunday at 2?",
    );
    await send(
      door({ group, dms, rsvp: rsvpReading({ intent: 'rsvp', response: 'yes', samePlan: true }) }),
      PARENT_B,
      'm2',
      "we're in!",
    );

    const plans = await db.database.select().from(schema.linqGroupPlans);
    const zoo = plans.find((plan) => plan.title === 'zoo');
    expect(zoo?.closedAt).toBeNull();
    expect(zoo?.startsAt?.toISOString()).toBe(new Date(SUNDAY_14).toISOString());
    expect(plans.find((plan) => plan.id === picnic.id)?.closedAt).not.toBeNull();
    const closed = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'));
    expect(closed.map((row) => (row.after as { reason?: string }).reason)).toEqual(['superseded']);

    const rsvps = await db.database.select().from(schema.linqGroupPlanRsvps);
    expect(rsvps.map((row) => [row.planId, row.response])).toEqual([[zoo?.id, 'yes']]);
    expect(group.some((line) => line.startsWith('tracking_started zoo'))).toBe(true);
    expect(group.filter((line) => line.includes('picnic'))).toEqual([]);
    expect(dms.filter((body) => body.includes('picnic'))).toEqual([]);
    expect(dms.filter((body) => body.startsWith('calendar_ask zoo Bao'))).toHaveLength(1);
    const consents = await db.database.select().from(schema.linqGroupPlanCalendarConsents);
    expect(consents.map((row) => [row.planId, row.familyId])).toEqual([[zoo?.id, b.familyId]]);
  });

  it('an opening the reader ties to the open plan keeps it (control)', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const group: string[] = [];
    await send(
      door({
        group,
        dms: [],
        rsvp: rsvpReading({ intent: 'start_tracking', planTitle: 'picnic', samePlan: true }),
      }),
      PARENT_A,
      'm1',
      'Hale can you count who is coming to the picnic?',
    );
    const plans = await db.database.select().from(schema.linqGroupPlans);
    expect(plans.map((plan) => [plan.id, plan.closedAt])).toEqual([[picnic.id, null]]);
  });

  it('an opening the reader cannot place against the open plan changes nothing', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const group: string[] = [];
    await send(
      door({
        group,
        dms: [],
        rsvp: rsvpReading({ intent: 'start_tracking', planTitle: 'zoo', samePlan: null }),
      }),
      PARENT_A,
      'm1',
      'Hale can you keep count for the zoo?',
    );
    const plans = await db.database.select().from(schema.linqGroupPlans);
    expect(plans.map((plan) => [plan.id, plan.closedAt])).toEqual([[picnic.id, null]]);
    expect(group.filter((line) => line.startsWith('tracking_started'))).toEqual([]);
  });

  it('an answer the reader ties to another event never lands on the open plan', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const dms: string[] = [];
    await send(
      door({
        group: [],
        dms,
        rsvp: rsvpReading({ intent: 'rsvp', response: 'yes', samePlan: false }),
      }),
      PARENT_B,
      'm1',
      "we're in for the zoo on Sunday",
    );
    const rsvps = await db.database
      .select()
      .from(schema.linqGroupPlanRsvps)
      .where(eq(schema.linqGroupPlanRsvps.planId, picnic.id));
    expect(rsvps).toEqual([]);
    expect(dms.filter((body) => body.includes('picnic'))).toEqual([]);
  });
});

describe('the group-moment RSVP vote binds only to the plan it is about (gate R1, probe V1)', () => {
  const vote = (samePlan: boolean | null): GroupExperienceReading => ({
    ...none,
    kind: 'rsvp_vote',
    response: 'yes',
    samePlan,
  });

  async function picnicRsvps(planId: string) {
    return db.database
      .select()
      .from(schema.linqGroupPlanRsvps)
      .where(eq(schema.linqGroupPlanRsvps.planId, planId));
  }

  it('an answer about another event that the second reader reads as a vote with no plan named records nothing and asks nothing', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const group: string[] = [];
    const dms: string[] = [];
    await send(
      door({
        group,
        dms,
        rsvp: rsvpReading({ intent: 'rsvp', response: 'yes', samePlan: false }),
        experience: vote(null),
      }),
      PARENT_B,
      'm1',
      "we're in for the zoo on Sunday",
    );
    expect(await picnicRsvps(picnic.id)).toEqual([]);
    expect(group.filter((line) => line.includes('picnic'))).toEqual([]);
    expect(dms).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupPlanCalendarConsents)).toEqual([]);
  });

  it('the second reader never overrides the first reader naming another event', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const dms: string[] = [];
    await send(
      door({
        group: [],
        dms,
        rsvp: rsvpReading({ intent: 'rsvp', response: 'yes', samePlan: false }),
        experience: vote(true),
      }),
      PARENT_B,
      'm1',
      "we're in for the zoo on Sunday",
    );
    expect(await picnicRsvps(picnic.id)).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('a vote the second reader does not tie to the open plan is not counted there', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const dms: string[] = [];
    await send(
      door({ group: [], dms, rsvp: rsvpReading({ intent: 'chatter' }), experience: vote(null) }),
      PARENT_B,
      'm1',
      "we're in for the zoo on Sunday",
    );
    expect(await picnicRsvps(picnic.id)).toEqual([]);
    expect(dms).toEqual([]);
  });

  it('a vote the second reader ties to the open plan lands on it (control)', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    await send(
      door({ group: [], dms: [], rsvp: rsvpReading({ intent: 'chatter' }), experience: vote(true) }),
      PARENT_B,
      'm1',
      'count us in',
    );
    expect((await picnicRsvps(picnic.id)).map((row) => row.response)).toEqual(['yes']);
  });
});

describe('a lock when VIL-471 owns the poll, through the door (gate REFUTED 2)', () => {
  async function pollWithTwoSundayVotes(familyId: string) {
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const poll = await plans.createPoll({
      chatId: CHAT,
      familyId,
      question: 'zoo when?',
      options: [
        { text: 'Saturday 10', providerOptionId: null },
        { text: 'Sunday 2', providerOptionId: null },
      ],
      expected: [],
      origin: 'parent',
      providerMessageId: null,
      now: NOW,
    });
    for (const [key, name] of [
      [phoneBlindIndex(PARENT_A), 'Ada'],
      [phoneBlindIndex(PARENT_B), 'Bao'],
    ] as const) {
      await plans.recordPollVote({
        pollId: poll.id,
        memberKey: key,
        displayName: name,
        userId: null,
        haleCustomer: true,
        optionKey: 'o2',
        source: 'text',
        now: NOW,
      });
    }
    return { plans, poll };
  }

  it('"Sunday it is, lock it in Hale" read as close_poll names the leader once and closes the poll', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const { plans, poll } = await pollWithTwoSundayVotes(a.familyId);
    const group: string[] = [];
    const experienceReads = { count: 0 };

    const body = await send(
      door({ group, dms: [], rsvp: rsvpReading({ intent: 'close_poll' }), experienceReads }),
      PARENT_B,
      'lock-1',
      'Sunday it is, lock it in Hale',
    );

    expect(body.outcome).toBe('group_experience_spoken');
    expect(await plans.loadLivePoll(CHAT)).toBeNull();
    expect(group).toHaveLength(1);
    expect(group[0]).toContain('Sunday 2');
    // The first reader decided; the message is not read a second time.
    expect(experienceReads.count).toBe(0);
    const closed = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_poll_closed'));
    expect(closed.map((row) => row.targetId)).toEqual([poll.id]);
  });

  it('a plain pick on the poll stays a vote and locks nothing (control)', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const { plans } = await pollWithTwoSundayVotes(a.familyId);
    const group: string[] = [];
    await send(
      door({ group, dms: [], rsvp: rsvpReading({ intent: 'poll_vote', pollChoice: 'o1' }) }),
      PARENT_B,
      'vote-1',
      'actually Saturday works better for us',
    );
    expect(await plans.loadLivePoll(CHAT)).not.toBeNull();
    expect(group.filter((line) => line.startsWith('time_lock'))).toEqual([]);
    expect(group.filter((line) => line.includes('Saturday 10'))).toEqual([]);
  });
});

describe('a poll about the open plan carries placed choices, and its lock moves the plan (gate R3, through the door)', () => {
  it('the reader gets the household clock, each choice is placed on the open plan, and "Sunday, lock it in" moves the plan to Sunday', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: CHAT })
      .where(eq(schema.families.id, a.familyId));
    const picnic = await openPicnic(a.familyId, a.userId);
    const group: string[] = [];
    const rsvpInputs: unknown[] = [];
    await send(
      door({
        group,
        dms: [],
        rsvpInputs,
        rsvp: rsvpReading({
          intent: 'start_poll',
          samePlan: true,
          pollQuestion: 'picnic time?',
          pollOptions: ['Saturday 10', 'Sunday 2'],
          pollStarts: [SATURDAY_10, SUNDAY_14],
        }),
      }),
      PARENT_A,
      'poll-1',
      'Hale can we vote on the picnic time, Saturday 10 or Sunday 2?',
    );
    expect(rsvpInputs[0]).toMatchObject({ clock: { timeZone: 'America/Toronto' } });
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const poll = await plans.loadLivePoll(CHAT);
    expect(poll?.options.map((option) => option.places)).toEqual([
      { planId: picnic.id, startsAt: SATURDAY_10 },
      { planId: picnic.id, startsAt: SUNDAY_14 },
    ]);
    // A claimed chat with another family in it holds group lines until its roster is
    // confirmed; releasing the claim lets this shared chat hear the lock line.
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: null })
      .where(eq(schema.families.id, a.familyId));

    const locked = await send(
      door({
        group,
        dms: [],
        rsvp: rsvpReading({ intent: 'close_poll', samePlan: true, pollChoice: 'o2' }),
      }),
      PARENT_B,
      'lock-1',
      'Sunday, lock it in Hale',
    );
    expect(locked.outcome).toBe('group_experience_spoken');
    expect(await plans.loadLivePoll(CHAT)).toBeNull();
    const [row] = await db.database
      .select()
      .from(schema.linqGroupPlans)
      .where(eq(schema.linqGroupPlans.id, picnic.id));
    expect(row?.startsAt).toEqual(new Date(SUNDAY_14));
    expect(group.filter((line) => line.startsWith('time_lock'))).toEqual([
      'time_lock {"winner":"Sunday 2"}',
    ]);
  });

  it('a poll the reader does not tie to the open plan places nothing (control)', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: CHAT })
      .where(eq(schema.families.id, a.familyId));
    await openPicnic(a.familyId, a.userId);
    await send(
      door({
        group: [],
        dms: [],
        rsvp: rsvpReading({
          intent: 'start_poll',
          samePlan: false,
          pollQuestion: 'zoo when?',
          pollOptions: ['Saturday 10', 'Sunday 2'],
          pollStarts: [SATURDAY_10, SUNDAY_14],
        }),
      }),
      PARENT_A,
      'poll-1',
      'Hale poll Saturday 10 or Sunday 2 for the zoo?',
    );
    const poll = await createPostgresGroupPlanRsvpStore(db.database).loadLivePoll(CHAT);
    expect(poll?.options.map((option) => option.places ?? null)).toEqual([null, null]);
  });
});
