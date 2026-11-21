import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { seedTextedHale } from '~/lib/testing/group-scenes';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { runCarpoolReminders } from './carpool';
import type { CarpoolReading } from './carpool-apply';
import { fakeCarpoolComposer } from './carpool-voice';
import type { GroupExperienceReading } from './group-experience/reading-legacy';
import { fakeGroupExperienceComposer } from './group-experience/voice-fake';
import type { PrivateAsideModel } from './group-private-aside';
import { sendGroupPlanRsvpLine } from './group-plan-rsvp/send';
import { createPostgresGroupPlanRsvpStore, openPlanOrNone } from './group-plan-rsvp/store';
import { fakeGroupPlanRsvpComposer } from './group-plan-rsvp/voice-fake';
import { handleLinqGroupMessage } from './inbound';
import type { SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

/**
 * VIL-689 · merging the group scenes changes nothing while LINQ_GROUP_SCENES_ENABLED is off.
 * These are the paths a differential probe against main showed moving under flags that may
 * already be on. Each test states what main did, with the scenes flag unset.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-scenes-flag';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const FROM = '+15555550100';

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
  vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_carpools, linq_group_rosters, linq_group_plans, linq_group_experience, family_events, audit_log, channel_messages cascade',
  );
});

async function household(phone: string, name: string, chat: string | null = CHAT) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', linqGroupChatId: chat })
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
  return { familyId, userId };
}

async function confirmedRoster(familyId: string, phone: string) {
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  await db.database.insert(schema.linqGroupRosterMembers).values({
    rosterId: roster?.id as string,
    chatId: CHAT,
    phoneE164Hash: phoneBlindIndex(phone),
    status: 'known_parent',
  });
}

function reading(partial: Partial<GroupExperienceReading>): GroupExperienceReading {
  return {
    kind: 'none',
    title: null,
    response: null,
    optionKey: null,
    options: [],
    confidence: 'high',
    ...partial,
  };
}

const noAside: PrivateAsideModel = {
  async read() {
    return [];
  },
  async draft() {
    return { send: false, about: '', text: '' };
  },
};

const question: SharedGroupReader = {
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

async function say(
  text: string,
  from: string,
  id: string,
  options: {
    experience?: GroupExperienceReading;
    ride?: CarpoolReading;
    others?: string[];
  } = {},
) {
  const group: string[] = [];
  const dm: string[] = [];
  const others = options.others ?? [];
  const response = await handleLinqGroupMessage(
    {
      database: db.database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      enqueue: async () => {},
      now: () => NOW,
      sendGroupText: async ({ text: line }: { chatId: string; text: string }) => {
        group.push(line);
        return { providerMessageId: `g-${group.length}` };
      },
      oneToOne: {
        text: async ({ to }: { to: string; body: string }) => {
          dm.push(to);
          return { providerMessageId: `dm-${dm.length}`, chatId: `dm-${dm.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
      listChatHandles: async () => ({ status: 'ok', handles: [from, ...others], isGroup: true }),
      sharedGroupReader: question,
      sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
      privateAsideModel: noAside,
      groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
      groupExperienceReader: { read: async () => options.experience ?? reading({}) },
      groupExperienceComposer: fakeGroupExperienceComposer({
        body: (input) => `moment:${input.kind}`,
      }),
      ...(options.ride ? { carpoolReader: { read: async () => options.ride } } : {}),
      carpoolVoice: fakeCarpoolComposer(),
    } as unknown as Parameters<typeof handleLinqGroupMessage>[0],
    {
      messageId: id,
      chatId: CHAT,
      senderHandle: from,
      text,
      mediaCount: 0,
      receivedAt: NOW,
      sentAt: NOW,
      otherHandles: others,
      mentions: [],
      isGroup: true,
    },
  );
  return { body: (await response.json()) as Record<string, unknown>, group, dm };
}

describe('LINQ_GROUP_SCENES_ENABLED off: group polls with plan RSVPs off', () => {
  it('still records a text RSVP, answers the tally and places the calendar copy', async () => {
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: new Date('2026-11-14T15:00:00.000Z'),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [{ memberKey: phoneBlindIndex(PARENT_A), displayName: 'Ada', userId: a.userId, haleCustomer: true }],
      now: NOW,
    });
    const out = await say('we are in', PARENT_A, 'm-1', {
      experience: reading({ kind: 'rsvp_vote', response: 'yes' }),
    });
    const rsvps = await db.database
      .select({ response: schema.linqGroupPlanRsvps.response })
      .from(schema.linqGroupPlanRsvps)
      .where(eq(schema.linqGroupPlanRsvps.planId, plan.id));
    expect(rsvps).toEqual([{ response: 'yes' }]);
    expect(out.group).toEqual(['moment:rsvp_tally']);
    const copies = await db.database
      .select({ id: schema.familyEvents.id })
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, a.familyId));
    expect(copies).toHaveLength(1);
  });
});

describe('LINQ_GROUP_SCENES_ENABLED off: rides', () => {
  const PICKUP = new Date('2026-11-17T22:30:00.000Z');
  const FIRE = new Date('2026-11-16T23:00:00.000Z');

  async function dueRide(familyId: string, driverUserId: string) {
    await db.database.insert(schema.linqGroupCarpools).values({
      chatId: CHAT,
      familyId,
      planKey: 'soccer:2026-11-17',
      eventLabel: 'soccer',
      pickupAt: PICKUP,
      driverName: 'Bao',
      driverUserId,
      driverHaleCustomer: 'true',
      status: 'assigned',
      reminderStatus: 'pending',
      reminderFireAt: FIRE,
    });
  }

  async function remind() {
    const group: string[] = [];
    const driver: string[] = [];
    await runCarpoolReminders(db.database, {
      now: new Date(FIRE.getTime() + 5 * 60 * 1000),
      send: async ({ text }) => {
        group.push(text);
        return { providerMessageId: `g-${group.length}` };
      },
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ text }) => {
        driver.push(text);
        return { sent: true, providerMessageId: 'driver-1' };
      },
      listChatHandles: async () => ({ status: 'ok', handles: [PARENT_A], isGroup: true }),
    });
    return { group, driver };
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'true');
  });

  it('a household ride reminds the group, and writes no audience on the row', async () => {
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    await dueRide(a.familyId, a.userId);
    const { group } = await remind();
    expect(group).toHaveLength(1);
    const [row] = await db.database.select().from(schema.linqGroupCarpools);
    expect(row?.chatAudience).toBeNull();
    expect(row?.reminderStatus).toBe('sent');
  });

  it('a driver whose family claimed any group gets no 1:1, as on main', async () => {
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    const b = await household(PARENT_B, 'Bao', 'chat-bao-own');
    await seedTextedHale(db.database, { ...b, at: NOW });
    await dueRide(a.familyId, b.userId);
    const { driver } = await remind();
    expect(driver).toEqual([]);
  });

  it('a driver with no claimed group gets the 1:1 without having texted Hale, as on main', async () => {
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    const b = await household(PARENT_B, 'Bao', null);
    await dueRide(a.familyId, b.userId);
    const { driver } = await remind();
    expect(driver).toHaveLength(1);
  });

  it('a ride already recorded as shared never goes to the group when the flag is killed', async () => {
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    const b = await household(PARENT_B, 'Bao', null);
    await seedTextedHale(db.database, { ...b, at: NOW });
    await dueRide(a.familyId, b.userId);
    await db.database.update(schema.linqGroupCarpools).set({ chatAudience: 'shared' });
    const { group, driver } = await remind();
    expect(group).toEqual([]);
    expect(driver).toHaveLength(1);
  });
});

describe('LINQ_GROUP_SCENES_ENABLED off: a chat several families share', () => {
  async function seatShared(phone: string, name: string) {
    const family = await household(phone, name, null);
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId: CHAT,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      familyId: family.familyId,
      userId: family.userId,
      firstName: name,
    });
    await db.database
      .insert(schema.linqMultiFamilyJoins)
      .values({ chatId: CHAT, familyId: family.familyId, joinedByUserId: family.userId, joinedAt: NOW });
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: CHAT,
      familyId: family.familyId,
      userId: family.userId,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      role: 'parent',
    });
    return family;
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'true');
    vi.stubEnv('GROUP_LINK_CARDS_ENABLED', 'true');
  });

  it('a ride message writes no ride and the plain answer still goes out', async () => {
    await seatShared(PARENT_A, 'Ada');
    await seatShared(PARENT_B, 'Bao');
    const out = await say("I'll drive soccer Tuesday 5:30", PARENT_B, 'm-ride', {
      others: [PARENT_A],
      ride: {
        intent: 'driver_claim',
        driverName: null,
        driverIsSender: true,
        eventLabel: 'soccer',
        pickupAtIso: null,
        pickupDate: '2026-11-17',
        pickupTime: '17:30',
        pickupPlace: null,
        kids: null,
        confidence: 'high',
      },
    });
    expect(await db.database.select().from(schema.linqGroupCarpools)).toEqual([]);
    expect(out.group).toEqual(['shared-reply-line']);
  });

  it('a posted link gets the plain answer, with no group moment before it', async () => {
    await seatShared(PARENT_A, 'Ada');
    await seatShared(PARENT_B, 'Bao');
    const out = await say('anyone want this? https://park.example/camp', PARENT_A, 'm-link', {
      others: [PARENT_B],
      experience: reading({ kind: 'link_facts' }),
    });
    expect(out.group).toEqual(['shared-reply-line']);
    expect(out.dm).toEqual([]);
  });
});

describe('the one-open-plan index stays until the scenes are lit', () => {
  async function secondPlan(store: ReturnType<typeof createPostgresGroupPlanRsvpStore>, familyId: string, userId: string) {
    return openPlanOrNone(store, {
      chatId: CHAT,
      familyId,
      title: 'zoo',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: userId,
      expected: [],
      now: NOW,
    });
  }

  it('a second open plan in a chat is refused, and the first stays open', async () => {
    const a = await household(PARENT_A, 'Ada');
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const first = await store.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    await expect(
      store.createPlan({
        chatId: CHAT,
        familyId: a.familyId,
        title: 'zoo',
        startsAt: null,
        location: null,
        rsvpDeadlineAt: null,
        createdByUserId: a.userId,
        expected: [],
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(await secondPlan(store, a.familyId, a.userId)).toBeNull();
    const open = await db.database
      .select({ id: schema.linqGroupPlans.id, closedAt: schema.linqGroupPlans.closedAt })
      .from(schema.linqGroupPlans);
    expect(open).toEqual([{ id: first.id, closedAt: null }]);
  });

  it('once the first plan closes, the next one opens (positive control)', async () => {
    const a = await household(PARENT_A, 'Ada');
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const first = await store.createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    await db.database
      .update(schema.linqGroupPlans)
      .set({ closedAt: NOW })
      .where(eq(schema.linqGroupPlans.id, first.id));
    const next = await secondPlan(store, a.familyId, a.userId);
    expect(next?.title).toBe('zoo');
  });
});

describe('sendGroupPlanRsvpLine with no household named', () => {
  it('ledgers on the covering family, as it always did', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const a = await household(PARENT_A, 'Ada');
    await confirmedRoster(a.familyId, PARENT_A);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'GET'
          ? Response.json({
              chat: {
                id: CHAT,
                is_group: true,
                handles: [
                  { handle: FROM, is_me: true },
                  { handle: PARENT_A, is_me: false },
                ],
              },
            })
          : Response.json({ message: { id: 'out-1' } }, { status: 201 }),
      ) as unknown as typeof fetch,
    );
    await sendGroupPlanRsvpLine(db.database, {
      chatId: CHAT,
      text: 'a tally line',
      templateKey: 'linq:group_plan_rsvp',
      now: NOW,
    });
    vi.unstubAllGlobals();
    const rows = await db.database
      .select({ familyId: schema.channelMessages.familyId })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(rows).toEqual([{ familyId: a.familyId }]);
  });
});
