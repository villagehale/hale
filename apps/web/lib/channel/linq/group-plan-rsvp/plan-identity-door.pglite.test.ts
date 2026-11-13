import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { linqInboundDeps } from '../deps';
import type { GroupExperienceReading } from '../group-experience/reading';
import { fakeGroupExperienceComposer } from '../group-experience/voice-fake';
import type { PrivateAsideModel } from '../group-private-aside';
import { handleLinqGroupMessage } from '../inbound';
import type { SharedGroupReader } from '../shared-group-reading';
import { fakeSharedGroupComposer } from '../shared-group-voice-fake';
import { considerGroupPlanRsvp } from './inbound';
import type { GroupPlanRsvpReading } from './reading';
import { GROUP_PLAN_RSVP_TEMPLATE, GROUP_POLL_TEMPLATE } from './send';
import { createPostgresGroupPlanRsvpStore } from './store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-689 · the one plan-identity rule, through the production wiring: `linqInboundDeps()`
 * (no `sendGroupText`, so every group line goes through the ledgered sender and the family
 * floor), pglite, and only the model's JSON and Linq's HTTP answers stipulated. Every vote,
 * RSVP and lock names its plan by an id code resolved; a chat can hold several open plans.
 */

let db: TestDb;
vi.mock('~/lib/db', () => ({ db: () => db.database }));

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-plan-identity';
const BASE = 'https://api.linqapp.com/api/partner/v3';
// 16:00Z is 11:00 in Toronto: daytime for every household here.
const NOW = new Date('2026-11-12T16:00:00.000Z');
const HALE = '+15555550100';
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const SATURDAY_10 = '2026-11-14T10:00:00-05:00';

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  for (const flag of [
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'LINQ_GROUP_ONBOARDING_V2_ENABLED',
    'GROUP_POLLS_ENABLED',
    'GROUP_LINK_CARDS_ENABLED',
    'GROUP_PRIVATE_QUESTION_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED',
    'LINQ_GROUP_POLLS_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, linq_group_polls, audit_log, channel_messages cascade',
  );
});

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** Linq's HTTP answers: the chat's participants on a GET, an accepted id on a POST. */
function linqWire() {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url: String(url), body });
    if (method === 'GET') {
      return Response.json({
        chat: {
          id: CHAT,
          is_group: true,
          handles: [
            { handle: HALE, is_me: true },
            { handle: PARENT_A, is_me: false },
            { handle: PARENT_B, is_me: false },
          ],
        },
      });
    }
    return Response.json({ message: { id: `out-${calls.length}` } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
  const groupPosts = () =>
    calls.filter((c) => c.method === 'POST' && c.url.startsWith(`${BASE}/chats/${CHAT}/`));
  return { calls, groupPosts };
}

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
      intent: 'chatter',
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
const noMoment: GroupExperienceReading = {
  kind: 'none',
  title: null,
  samePlan: null,
  response: null,
  optionKey: null,
  options: [],
  starts: [],
  confidence: 'high',
};

function reading(partial: Partial<GroupPlanRsvpReading>): GroupPlanRsvpReading {
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
    planKey: null,
    replacesPlanKey: null,
    addressed: false,
    pollQuestion: null,
    pollOptions: [],
    pollStarts: [],
    pollChoice: null,
    ...partial,
  };
}

/** The production door deps, with only the model's answers stipulated. */
function productionDoor(rsvp: GroupPlanRsvpReading, seen?: unknown[]) {
  return {
    ...linqInboundDeps(),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
    sharedGroupReader: sharedReader,
    sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
    privateAsideModel: noAside,
    groupPlanRsvpReader: {
      read: async (input: unknown) => {
        seen?.push(input);
        return rsvp;
      },
    },
    groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
    // A group message is never a household's calendar answer here.
    groupPlanCalendarConsentReader: {
      read: async () => ({ decision: 'not_this' as const, confidence: 'high' as const }),
    },
    groupExperienceReader: { read: async () => noMoment },
    groupExperienceComposer: fakeGroupExperienceComposer(),
  } as unknown as Parameters<typeof handleLinqGroupMessage>[0];
}

async function say(rsvp: GroupPlanRsvpReading, from: string, id: string, text: string) {
  const seen: unknown[] = [];
  const response = await handleLinqGroupMessage(productionDoor(rsvp, seen), {
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
  return { body: (await response.json()) as Record<string, unknown>, seen };
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
    now: new Date(NOW.getTime() - 60 * 60 * 1000),
  });
}

async function ledger(templateKey: string) {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.templateKey, templateKey));
}

describe('a poll in a chat several families share, with no plan open (gate-3 R4)', () => {
  it('is made first, then said, ledgered on the asker household, and reaches Linq', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const wire = linqWire();

    const out = await say(
      reading({
        intent: 'start_poll',
        addressed: true,
        pollQuestion: 'pizza or tacos?',
        pollOptions: ['pizza', 'tacos'],
        pollStarts: [null, null],
      }),
      PARENT_A,
      'poll-1',
      'Hale poll pizza or tacos?',
    );

    expect(out.body.outcome).toBe('group_poll_spoken');
    const polls = await db.database.select().from(schema.linqGroupPolls);
    expect(polls).toHaveLength(1);
    expect(polls[0]?.familyId).toBe(a.familyId);
    expect(polls[0]?.closedAt).toBeNull();
    expect(polls[0]?.createdByMemberKey).toBe(phoneBlindIndex(PARENT_A));
    expect(polls[0]?.options.map((option) => option.places ?? null)).toEqual([null, null]);
    expect(wire.groupPosts()).toHaveLength(1);
    const rows = await ledger(GROUP_POLL_TEMPLATE);
    expect(rows.map((row) => [row.familyId, row.status, row.providerChatId])).toEqual([
      [a.familyId, 'sent', CHAT],
    ]);
  });

  it('positive control: a reader that hears no poll leaves no poll row and sends no poll line', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    linqWire();
    await say(reading({ intent: 'chatter' }), PARENT_A, 'chat-1', 'pizza or tacos, lol');
    expect(await db.database.select().from(schema.linqGroupPolls)).toEqual([]);
    expect(await ledger(GROUP_POLL_TEMPLATE)).toEqual([]);
  });
});

describe('a chat holds several open plans; each message binds to one only by its id', () => {
  it('a new event never supersedes a plan still ahead: its late RSVP and its pending 1:1 ask still bind', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const store = createPostgresGroupPlanRsvpStore(db.database);
    // Bao's household was asked 1:1 to put the picnic on its calendar.
    await store.claimCalendarAsk({
      planId: picnic.id,
      familyId: b.familyId,
      memberKey: phoneBlindIndex(PARENT_B),
      displayName: 'Bao',
      householdLabel: null,
      now: NOW,
    });
    linqWire();

    const opened = await say(
      reading({
        intent: 'start_tracking',
        planTitle: 'zoo',
        startsAt: '2026-11-15T14:00:00-05:00',
        planKey: 'other',
        addressed: true,
      }),
      PARENT_A,
      'm1',
      "Hale who's in for the zoo Sunday at 2?",
    );
    expect(opened.body.outcome).toBe('group_plan_spoken');
    const open = await store.listOpenPlans(CHAT, NOW);
    expect(open.map((plan) => plan.title)).toEqual(['zoo', 'picnic']);
    expect(
      await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed')),
    ).toEqual([]);
    // The pending 1:1 ask on the picnic still binds.
    expect((await store.listOpenCalendarAsks(b.userId)).map((ask) => ask.plan.id)).toEqual([
      picnic.id,
    ]);

    // The reader is shown both plans by key (newest first) and names the picnic.
    const late = await say(
      reading({ intent: 'rsvp', response: 'yes', planKey: 'p2' }),
      PARENT_B,
      'm2',
      'we are in for the picnic',
    );
    expect(late.seen[0]).toMatchObject({
      plans: [
        { key: 'p1', title: 'zoo' },
        { key: 'p2', title: 'picnic' },
      ],
    });
    const rsvps = await db.database.select().from(schema.linqGroupPlanRsvps);
    expect(rsvps.map((row) => [row.planId, row.response])).toEqual([[picnic.id, 'yes']]);
  });

  it('an event the sender says replaces an open plan closes that one, by id, as superseded', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    linqWire();
    await say(
      reading({
        intent: 'start_tracking',
        planTitle: 'zoo',
        planKey: 'other',
        replacesPlanKey: 'p1',
        addressed: true,
      }),
      PARENT_A,
      'm1',
      "Hale, rain on Saturday, let's do the zoo instead of the picnic",
    );
    const store = createPostgresGroupPlanRsvpStore(db.database);
    expect((await store.listOpenPlans(CHAT, NOW)).map((plan) => plan.title)).toEqual(['zoo']);
    const closed = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'));
    expect(closed.map((row) => [row.targetId, (row.after as { reason: string }).reason])).toEqual([
      [picnic.id, 'superseded'],
    ]);
  });

  it('an answer that could be either plan binds nothing; spoken to Hale, Hale asks which in one line', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    await openPicnic(a.familyId, a.userId);
    const store = createPostgresGroupPlanRsvpStore(db.database);
    await store.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'zoo',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    const wire = linqWire();

    const out = await say(
      reading({ intent: 'rsvp', response: 'yes', planKey: 'unclear', addressed: true }),
      PARENT_B,
      'm1',
      'Hale count us in',
    );
    expect(out.body.outcome).toBe('group_plan_which_asked');
    expect(await db.database.select().from(schema.linqGroupPlanRsvps)).toEqual([]);
    expect(wire.groupPosts()).toHaveLength(1);
    const rows = await ledger(GROUP_PLAN_RSVP_TEMPLATE);
    expect(rows.map((row) => [row.familyId, row.body])).toEqual([
      [b.familyId, 'which_plan zoo picnic?'],
    ]);
  });

  it('the reader marking that doubt as low confidence (as the recorded read does) still asks which', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await openPicnic(a.familyId, a.userId);
    await createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'zoo',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    linqWire();
    const out = await say(
      reading({
        intent: 'rsvp',
        response: 'yes',
        planKey: 'unclear',
        addressed: true,
        confidence: 'low',
      }),
      PARENT_B,
      'm1',
      'Hale count us in!',
    );
    expect(out.body.outcome).toBe('group_plan_which_asked');
    expect(await db.database.select().from(schema.linqGroupPlanRsvps)).toEqual([]);
  });

  it('the same unclear answer not spoken to Hale binds nothing and says nothing', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await openPicnic(a.familyId, a.userId);
    await createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'zoo',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    const wire = linqWire();
    await say(
      reading({ intent: 'rsvp', response: 'yes', planKey: 'unclear', addressed: false }),
      PARENT_B,
      'm1',
      "we're in!",
    );
    expect(await db.database.select().from(schema.linqGroupPlanRsvps)).toEqual([]);
    expect(await ledger(GROUP_PLAN_RSVP_TEMPLATE)).toEqual([]);
    expect(wire.groupPosts()).toEqual([]);
  });

  it('a key the reader was never shown binds nothing', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    await openPicnic(a.familyId, a.userId);
    linqWire();
    await say(
      reading({ intent: 'rsvp', response: 'yes', planKey: 'p7' }),
      PARENT_B,
      'm1',
      'count us in',
    );
    expect(await db.database.select().from(schema.linqGroupPlanRsvps)).toEqual([]);
  });

  it('a tapback binds to the plan of the Hale line it landed on, never to another open plan', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const wire = linqWire();
    // Hale's tracking line for the zoo goes out (its ledger row carries the zoo plan id).
    await say(
      reading({ intent: 'start_tracking', planTitle: 'zoo', planKey: 'other', addressed: true }),
      PARENT_A,
      'm1',
      'Hale track the zoo Sunday',
    );
    const [zooLine] = await ledger(GROUP_PLAN_RSVP_TEMPLATE);
    const zooLineId = zooLine?.providerMessageId as string;
    expect(wire.groupPosts()).toHaveLength(1);

    const tap = await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
        // The production reader answers a bare yes tapback by protocol (readingFromTapback).
        reader: { read: async () => reading({ intent: 'rsvp', response: 'yes' }) },
        composer: fakeGroupPlanRsvpComposer(),
        consentReader: { read: async () => ({ decision: 'not_this', confidence: 'high' }) },
      },
      {
        chatId: CHAT,
        senderHandle: PARENT_B,
        senderUserId: b.userId,
        text: '',
        tapback: 'like',
        tapbackMessageId: zooLineId,
      },
    );
    expect(tap).toMatchObject({ handled: true });
    const zoo = (await createPostgresGroupPlanRsvpStore(db.database).listOpenPlans(CHAT, NOW)).find(
      (plan) => plan.title === 'zoo',
    );
    const rsvps = await db.database.select().from(schema.linqGroupPlanRsvps);
    expect(rsvps.map((row) => [row.planId, row.response])).toEqual([[zoo?.id, 'yes']]);
    expect(rsvps.some((row) => row.planId === picnic.id)).toBe(false);
  });
});

describe('a plan time with no offset is placed on the household clock (start_tracking)', () => {
  it('"Sunday at 2" read as a wall-clock time lands at 2 pm Toronto, not 2 pm UTC', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    linqWire();
    await say(
      reading({
        intent: 'start_tracking',
        planTitle: 'zoo',
        startsAt: '2026-11-15T14:00:00',
        addressed: true,
      }),
      PARENT_A,
      'm1',
      "Hale who's in for the zoo Sunday at 2?",
    );
    const [zoo] = await db.database
      .select()
      .from(schema.linqGroupPlans)
      .where(and(eq(schema.linqGroupPlans.chatId, CHAT), eq(schema.linqGroupPlans.title, 'zoo')));
    expect(zoo?.startsAt?.toISOString()).toBe('2026-11-15T19:00:00.000Z');
  });

  it('positive control: a time with its own offset is kept as given', async () => {
    await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    linqWire();
    await say(
      reading({
        intent: 'start_tracking',
        planTitle: 'zoo',
        startsAt: '2026-11-15T14:00:00-05:00',
        addressed: true,
      }),
      PARENT_A,
      'm1',
      "Hale who's in for the zoo Sunday at 2?",
    );
    const [zoo] = await db.database.select().from(schema.linqGroupPlans);
    expect(zoo?.startsAt?.toISOString()).toBe('2026-11-15T19:00:00.000Z');
  });
});
