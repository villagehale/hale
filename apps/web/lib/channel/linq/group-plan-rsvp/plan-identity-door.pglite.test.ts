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
import { postgresGroupPlanCalendarWriter } from './calendar';
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
const SUNDAY_14 = '2026-11-15T14:00:00-05:00';
const DAY_MS = 24 * 60 * 60 * 1000;

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

let consentDecision: 'ok' | 'not_this' = 'not_this';
let consentReads = 0;
afterEach(() => {
  consentDecision = 'not_this';
  consentReads = 0;
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

async function seedFamily(phone: string, name: string, timezone = 'America/Toronto') {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone })
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
function productionDoor(
  rsvp: GroupPlanRsvpReading,
  seen?: unknown[],
  moment: GroupExperienceReading = noMoment,
) {
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
    // A group message is never a household's calendar answer here, unless a test says the
    // consent model would (wrongly) take it as one.
    groupPlanCalendarConsentReader: {
      read: async () => {
        consentReads += 1;
        return { decision: consentDecision, confidence: 'high' as const };
      },
    },
    groupExperienceReader: { read: async () => moment },
    groupExperienceComposer: fakeGroupExperienceComposer(),
  } as unknown as Parameters<typeof handleLinqGroupMessage>[0];
}

async function say(
  rsvp: GroupPlanRsvpReading,
  from: string,
  id: string,
  text: string,
  moment?: GroupExperienceReading,
) {
  const seen: unknown[] = [];
  const response = await handleLinqGroupMessage(productionDoor(rsvp, seen, moment), {
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
  it('"Sunday at 2" read as a wall-clock time lands at 2 pm on the household clock, never the server one', async () => {
    // Regina is neither UTC (CI) nor Toronto (a laptop), so a server-clock parse fails on both,
    // and it keeps UTC-6 all year, so the expected instant does not depend on tz data releases.
    await seedFamily(PARENT_A, 'Ada', 'America/Regina');
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
    expect(zoo?.startsAt?.toISOString()).toBe('2026-11-15T20:00:00.000Z');
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

/** A calendar copy Hale already wrote for `familyId` on `planId`, at Saturday 10. */
async function writeCopy(planId: string, familyId: string, userId: string, name: string) {
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  const written = await postgresGroupPlanCalendarWriter(db.database).write({
    planId,
    chatId: CHAT,
    familyId,
    title: 'picnic',
    startsAt: new Date(SATURDAY_10),
    location: null,
  });
  if (written.status === 'failed') throw new Error('seed: calendar copy not written');
  await plans.claimCalendarAsk({
    planId,
    familyId,
    memberKey: `key-${userId}`,
    displayName: name,
    householdLabel: null,
    now: NOW,
  });
  await plans.markCalendarWritten({
    planId,
    familyId,
    familyEventId: written.familyEventId,
    actorUserId: userId,
    now: NOW,
  });
  return written.familyEventId;
}

async function planStart(planId: string) {
  const [row] = await db.database
    .select({ startsAt: schema.linqGroupPlans.startsAt })
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.id, planId));
  return row?.startsAt ?? null;
}

async function copyStart(familyEventId: string) {
  const [row] = await db.database
    .select({ startsAt: schema.familyEvents.startsAt })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, familyEventId));
  return row?.startsAt ?? null;
}

const pollOnPicnic = reading({
  intent: 'start_poll',
  addressed: true,
  planKey: 'p1',
  pollQuestion: 'picnic time?',
  pollOptions: ['Saturday 10', 'Sunday 2'],
  pollStarts: [SATURDAY_10, SUNDAY_14],
});

describe('only the host household ties a poll to its plan, so only it can move the plan (gate R6-1)', () => {
  it('another household starts a poll on the host plan, votes and locks: neither the plan nor its copy moves', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const copy = await writeCopy(picnic.id, a.familyId, a.userId, 'Ada');
    linqWire();

    await say(
      pollOnPicnic,
      PARENT_B,
      'p-1',
      'Hale vote on the picnic time, Saturday 10 or Sunday 2',
    );
    const [poll] = await db.database.select().from(schema.linqGroupPolls);
    expect(poll?.options.map((option) => option.places ?? null)).toEqual([null, null]);
    await say(reading({ intent: 'poll_vote', pollChoice: 'o2' }), PARENT_B, 'p-2', 'Sunday');
    await say(
      reading({ intent: 'close_poll', pollChoice: 'o2', addressed: true }),
      PARENT_B,
      'p-3',
      'Hale lock in Sunday',
    );

    expect(await planStart(picnic.id)).toEqual(new Date(SATURDAY_10));
    expect(await copyStart(copy)).toEqual(new Date(SATURDAY_10));
    const moved = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_moved'));
    expect(moved).toEqual([]);
  });

  it('positive control: the host starts the same poll, it is tied to the plan, and the host lock moves both', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const copy = await writeCopy(picnic.id, a.familyId, a.userId, 'Ada');
    linqWire();

    await say(
      pollOnPicnic,
      PARENT_A,
      'p-1',
      'Hale vote on the picnic time, Saturday 10 or Sunday 2',
    );
    const [poll] = await db.database.select().from(schema.linqGroupPolls);
    expect(poll?.options.map((option) => option.places?.planId ?? null)).toEqual([
      picnic.id,
      picnic.id,
    ]);
    await say(reading({ intent: 'poll_vote', pollChoice: 'o2' }), PARENT_B, 'p-2', 'Sunday');
    await say(
      reading({ intent: 'close_poll', pollChoice: 'o2', addressed: true }),
      PARENT_A,
      'p-3',
      'Hale lock in Sunday',
    );

    expect(await planStart(picnic.id)).toEqual(new Date(SUNDAY_14));
    expect(await copyStart(copy)).toEqual(new Date(SUNDAY_14));
  });

  it('VIL-399: a time poll another household opens on the host plan is tied to no plan; the host one is', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    linqWire();
    const timeOpen: GroupExperienceReading = {
      ...noMoment,
      kind: 'time_open',
      title: 'picnic',
      samePlan: true,
      options: ['Saturday 10', 'Sunday 2'],
      starts: [SATURDAY_10, SUNDAY_14],
    };
    const livePlanId = async () => {
      const [row] = await db.database
        .select()
        .from(schema.linqGroupExperience)
        .where(
          and(
            eq(schema.linqGroupExperience.chatId, CHAT),
            eq(schema.linqGroupExperience.kind, 'time_poll'),
          ),
        );
      return row ? (row.payload.planId ?? null) : 'no poll';
    };

    await say(
      reading({ intent: 'chatter', planKey: 'p1' }),
      PARENT_B,
      't-1',
      'Hale poll Saturday 10 or Sunday 2 for the picnic',
      timeOpen,
    );
    expect(await livePlanId()).toBeNull();

    await db.exec('truncate table linq_group_experience');
    await say(
      reading({ intent: 'chatter', planKey: 'p1' }),
      PARENT_A,
      't-2',
      'Hale poll Saturday 10 or Sunday 2 for the picnic',
      timeOpen,
    );
    expect(await livePlanId()).toBe(picnic.id);
  });

  it('VIL-399: a new event a parent opens in a shared chat is that parent household plan', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    await openPicnic(a.familyId, a.userId);
    linqWire();
    await say(
      reading({ intent: 'chatter', planKey: 'other' }),
      PARENT_B,
      't-1',
      'Hale poll Saturday 10 or Sunday 2 for the zoo',
      {
        ...noMoment,
        kind: 'time_open',
        title: 'zoo',
        samePlan: false,
        options: ['Saturday 10', 'Sunday 2'],
        starts: [SATURDAY_10, SUNDAY_14],
      },
    );
    const zoo = (await createPostgresGroupPlanRsvpStore(db.database).listOpenPlans(CHAT, NOW)).find(
      (plan) => plan.title === 'zoo',
    );
    expect(zoo?.familyId).toBe(b.familyId);
  });
});

describe('a plan with no time closes once nobody has touched it for a while (gate R6-2)', () => {
  async function untimed(familyId: string, userId: string, title: string, ageMs: number) {
    return createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: CHAT,
      familyId,
      title,
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: userId,
      expected: [],
      now: new Date(NOW.getTime() - ageMs),
    });
  }

  it('a 40-day-old untouched plan closes (audited as idle) and the reader is never shown it', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const old = await untimed(a.familyId, a.userId, 'pizza night', 40 * DAY_MS);
    await untimed(a.familyId, a.userId, 'movie night', DAY_MS);
    linqWire();

    const out = await say(
      reading({ intent: 'rsvp', response: 'yes', planKey: 'p1', addressed: true }),
      PARENT_B,
      'r-1',
      'Hale count us in for movie night',
    );
    expect((out.seen[0] as { plans: { title: string }[] }).plans.map((plan) => plan.title)).toEqual(
      ['movie night'],
    );
    const closed = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'));
    expect(closed.map((row) => [row.targetId, (row.after as { reason: string }).reason])).toEqual([
      [old.id, 'idle'],
    ]);
  });

  it('positive control: an old plan with no time that someone answered yesterday stays open', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const old = await untimed(a.familyId, a.userId, 'pizza night', 40 * DAY_MS);
    await createPostgresGroupPlanRsvpStore(db.database).upsertRsvp({
      planId: old.id,
      memberKey: phoneBlindIndex(PARENT_B),
      displayName: 'Bao',
      householdLabel: null,
      userId: null,
      haleCustomer: true,
      response: 'yes',
      headcount: 1,
      source: 'text',
      coversKeys: [],
      verbatim: null,
      now: new Date(NOW.getTime() - DAY_MS),
    });
    const open = await createPostgresGroupPlanRsvpStore(db.database).listOpenPlans(CHAT, NOW);
    expect(open.map((plan) => plan.id)).toEqual([old.id]);
  });
});

describe('a replace closes a plan only by its id, and only for its host household (gate R6-3, M4)', () => {
  it('another household naming the host plan as replaced opens its own event; the host plan stays open', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
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
      PARENT_B,
      'r-1',
      "Hale forget the picnic, let's do the zoo instead",
    );
    const open = await createPostgresGroupPlanRsvpStore(db.database).listOpenPlans(CHAT, NOW);
    expect(open.map((plan) => [plan.title, plan.familyId])).toEqual([
      ['zoo', b.familyId],
      ['picnic', a.familyId],
    ]);
    expect(open.some((plan) => plan.id === picnic.id)).toBe(true);
  });

  it('with two plans open, the host replacing one closes that one only', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const museum = await store.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'museum',
      startsAt: new Date(SUNDAY_14),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: new Date(NOW.getTime() - 30 * 60 * 1000),
    });
    linqWire();
    // Newest first: p1 = museum, p2 = picnic.
    await say(
      reading({
        intent: 'start_tracking',
        planTitle: 'zoo',
        planKey: 'other',
        replacesPlanKey: 'p2',
        addressed: true,
      }),
      PARENT_A,
      'r-1',
      'Hale rain Saturday, the zoo instead of the picnic',
    );
    const open = await store.listOpenPlans(CHAT, NOW);
    expect(open.map((plan) => plan.title)).toEqual(['zoo', 'museum']);
    expect(open.some((plan) => plan.id === museum.id)).toBe(true);
    expect(open.some((plan) => plan.id === picnic.id)).toBe(false);
  });
});

describe('a tapback binds to the plan of the line it landed on, even an older one (M3b)', () => {
  it('a like on the picnic line, with the newer zoo open, is an RSVP on the picnic', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    linqWire();
    await say(
      reading({ intent: 'start_tracking', planTitle: 'picnic', addressed: true }),
      PARENT_A,
      'm1',
      'Hale track the picnic Saturday',
    );
    // The picnic is the older plan: the zoo is the newest open one.
    await db.database
      .update(schema.linqGroupPlans)
      .set({ createdAt: new Date(NOW.getTime() - 60 * 60 * 1000) })
      .where(eq(schema.linqGroupPlans.title, 'picnic'));
    await say(
      reading({ intent: 'start_tracking', planTitle: 'zoo', planKey: 'other', addressed: true }),
      PARENT_A,
      'm2',
      'Hale track the zoo Sunday',
    );
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const open = await store.listOpenPlans(CHAT, NOW);
    expect(open.map((plan) => plan.title)).toEqual(['zoo', 'picnic']);
    const picnic = open.find((plan) => plan.title === 'picnic');
    const lines = await ledger(GROUP_PLAN_RSVP_TEMPLATE);
    const picnicLine = lines.find((row) => row.dedupeKey?.includes(`:plan:${picnic?.id}:`));
    expect(picnicLine?.providerMessageId).toBeTruthy();

    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
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
        tapbackMessageId: picnicLine?.providerMessageId as string,
      },
    );
    const rsvps = await db.database.select().from(schema.linqGroupPlanRsvps);
    expect(rsvps.map((row) => [row.planId, row.response])).toEqual([[picnic?.id, 'yes']]);
    void a;
  });
});

describe('a group text answers a household calendar ask only when code knows which plan (pendingAskPlan)', () => {
  async function pendingOnPicnic() {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    const picnic = await openPicnic(a.familyId, a.userId);
    await createPostgresGroupPlanRsvpStore(db.database).claimCalendarAsk({
      planId: picnic.id,
      familyId: b.familyId,
      memberKey: phoneBlindIndex(PARENT_B),
      displayName: 'Bao',
      householdLabel: null,
      now: NOW,
    });
    return { a, b, picnic };
  }

  it('with two plans open, a consent model that would take the text as an OK is never asked', async () => {
    const { a } = await pendingOnPicnic();
    await createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'zoo',
      startsAt: new Date(SUNDAY_14),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    consentDecision = 'ok';
    linqWire();
    await say(reading({ intent: 'rsvp', response: 'yes', planKey: 'p1' }), PARENT_B, 'c-1', 'yes!');
    expect(consentReads).toBe(0);
    expect(await db.database.select().from(schema.familyEvents)).toEqual([]);
  });

  it('positive control: with the picnic the only plan open, the same text goes to the consent model', async () => {
    await pendingOnPicnic();
    linqWire();
    await say(reading({ intent: 'rsvp', response: 'yes', planKey: 'p1' }), PARENT_B, 'c-1', 'yes!');
    expect(consentReads).toBe(1);
  });
});
