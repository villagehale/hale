import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { considerCarpoolTurn, runCarpoolReminders } from './carpool';
import { applyCarpoolReading } from './carpool-apply';
import { fakeCarpoolComposer } from './carpool-voice';
import type { ListChatHandles } from './roster';

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-08T16:00:00.000Z');
const FRIDAY_EVE = new Date('2026-10-09T22:00:00.000Z');
const CHAT = 'chat-carpool-preview';
const PICKUP = '2026-10-10T12:00:00.000Z';
const MOM = '+15555550131';
const DAD = '+15555550132';
const FRIEND = '+15555550133';

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
  vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_group_carpools, audit_log, channel_messages, families, users, linq_group_rosters cascade',
  );
});

type MemberSeed = Pick<
  typeof schema.linqGroupRosterMembers.$inferInsert,
  'status' | 'confirmedRole'
> & { phone: string };

async function seedRoster(
  familyId: string,
  status: schema.LinqGroupRosterStatus,
  members: MemberSeed[],
): Promise<void> {
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status })
    .returning({ id: schema.linqGroupRosters.id });
  for (const { phone, ...member } of members) {
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(phone),
      ...member,
    });
  }
}

const PARENTS: MemberSeed[] = [
  { phone: MOM, status: 'known_parent' },
  { phone: DAD, status: 'confirmed', confirmedRole: 'co_parent' },
];

function present(...handles: string[]): ListChatHandles {
  return async () => ({ status: 'ok', handles, isGroup: true });
}

async function seed() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:maya', name: 'Maya Chen', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  return { familyId, userId };
}

function send() {
  const texts: string[] = [];
  return {
    texts,
    send: async (notice: { chatId: string; text: string }) => {
      texts.push(notice.text);
      return { providerMessageId: `preview-${texts.length}` };
    },
  };
}

describe('considerCarpoolTurn', () => {
  it('does nothing when the flag is off', async () => {
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'false');
    const { familyId, userId } = await seed();
    const door = send();
    const result = await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550111',
      senderUserId: userId,
      senderName: 'Maya',
      text: 'I can drive Saturday',
      now: NOW,
      send: door.send,
      reader: {
        read: async () => ({
          intent: 'driver_claim',
          driverName: 'Maya',
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    expect(result).toEqual({ handled: false, outcome: 'flag_off' });
    expect(door.texts).toEqual([]);
  });

  it('does not post the driver ask while someone in the group has not said who they are', async () => {
    const { familyId, userId } = await seed();
    await seedRoster(familyId, 'roles_proposed', [
      { phone: MOM, status: 'known_parent' },
      { phone: FRIEND, status: 'asked' },
    ]);
    const door = send();
    const asked = await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: MOM,
      senderUserId: userId,
      senderName: 'Maya',
      text: 'Soccer Saturday 8 at the rec, who can drive?',
      now: NOW,
      send: door.send,
      voice: fakeCarpoolComposer(),
      listChatHandles: present(MOM, FRIEND),
      reader: {
        read: async () => ({
          intent: 'plan_needs_driver',
          driverName: null,
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    expect(asked).toMatchObject({ handled: true, notice: 'not_sent' });
    expect(door.texts).toEqual([]);
  });

  it('records a driver and asks once when the group still needs one', async () => {
    const { familyId, userId } = await seed();
    await seedRoster(familyId, 'confirmed', PARENTS);
    const door = send();
    const voice = fakeCarpoolComposer();
    const asked = await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550111',
      senderUserId: userId,
      senderName: 'Maya',
      text: 'Soccer Saturday 8 at the rec, who can drive?',
      now: NOW,
      send: door.send,
      voice,
      listChatHandles: present(MOM, DAD),
      reader: {
        read: async () => ({
          intent: 'plan_needs_driver',
          driverName: null,
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    expect(asked).toMatchObject({ handled: true, outcome: 'carpool_asked', notice: 'sent' });
    expect(door.texts).toHaveLength(1);
    expect(door.texts[0]).toContain('ask_driver');

    const second = await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550112',
      senderUserId: userId,
      senderName: 'Luis',
      text: 'I can bring oranges',
      now: NOW,
      send: door.send,
      voice,
      reader: {
        read: async () => ({
          intent: 'plan_needs_driver',
          driverName: null,
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    expect(second.outcome).toBe('carpool_recorded');
    expect(door.texts).toHaveLength(1);
  });

  it('swaps the driver and then skips the reminder after a cancel', async () => {
    const { familyId, userId } = await seed();
    const door = send();
    const voice = fakeCarpoolComposer();
    await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550111',
      senderUserId: userId,
      senderName: 'Maya',
      text: 'I will drive Saturday soccer',
      now: NOW,
      send: door.send,
      voice,
      reader: {
        read: async () => ({
          intent: 'driver_claim',
          driverName: 'Maya',
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    const [priya] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'imessage:priya', name: 'Priya Shah', timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    // Devin #975 — only a member of the covering family (or seated) may swap.
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: priya?.id as string, role: 'co_parent' });
    const swapped = await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550113',
      senderUserId: priya?.id as string,
      senderName: 'Priya',
      text: 'I will take them instead',
      now: NOW,
      send: door.send,
      voice,
      reader: {
        read: async () => ({
          intent: 'driver_swap',
          driverName: 'Priya',
          driverIsSender: true,
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: 'the rec',
          kids: 'Noah',
          confidence: 'high',
        }),
      },
    });
    expect(swapped).toMatchObject({ handled: true, outcome: 'carpool_swapped' });

    const [row] = await db.database.select().from(schema.linqGroupCarpools);
    expect(row?.driverName).toBe('Priya');
    expect(row?.reminderStatus).toBe('pending');

    await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: '+14165550111',
      senderUserId: userId,
      senderName: 'Maya',
      text: 'game is off',
      now: NOW,
      send: door.send,
      voice,
      reader: {
        read: async () => ({
          intent: 'cancel',
          driverName: null,
          eventLabel: 'soccer',
          pickupAtIso: PICKUP,
          pickupPlace: null,
          kids: null,
          confidence: 'high',
        }),
      },
    });

    const ran = await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door.send,
      voice,
    });
    expect(ran.fired).toBe(0);
    expect(door.texts.filter((text) => text.includes('night_before'))).toEqual([]);
  });
});

async function insertAssigned(familyId: string, userId: string, chatId = CHAT) {
  const plan = applyCarpoolReading(
    null,
    {
      intent: 'driver_claim',
      driverName: 'Maya',
      eventLabel: 'soccer',
      pickupAtIso: PICKUP,
      pickupPlace: 'the rec',
      kids: 'Noah',
      confidence: 'high',
    },
    { userId, name: 'Maya', haleCustomer: true, timezone: 'America/Toronto' },
    NOW,
  );
  if (!plan) throw new Error('expected a plan');
  await db.database.insert(schema.linqGroupCarpools).values({
    chatId,
    familyId,
    planKey: plan.planKey,
    eventLabel: plan.eventLabel,
    pickupAt: plan.pickupAt,
    pickupPlace: plan.pickupPlace,
    kids: plan.kids,
    driverName: plan.driverName,
    driverUserId: userId,
    driverHaleCustomer: 'true',
    driverTimezone: 'America/Toronto',
    status: 'assigned',
    reminderFireAt: plan.reminderFireAt,
    reminderStatus: 'pending',
  });
  return plan;
}

describe('runCarpoolReminders', () => {
  it('reminds the group and the Hale-customer driver', async () => {
    const { familyId, userId } = await seed();
    await seedRoster(familyId, 'confirmed', PARENTS);
    const voice = fakeCarpoolComposer();
    const door = send();
    await insertAssigned(familyId, userId);
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerChatId: 'dm-driver',
      inGroup: false,
      status: 'delivered',
      sentAt: FRIDAY_EVE,
    });
    // Design (#975) — the driver 1:1 runs only for a family with no claimed group.
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: null })
      .where(eq(schema.families.id, familyId));
    const driverSends: string[] = [];
    const fired = await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door.send,
      voice,
      listChatHandles: present(MOM, DAD),
      sendDriver: async ({ text }) => {
        driverSends.push(text);
        return { sent: true, providerMessageId: 'driver-1' };
      },
    });
    expect(fired.fired).toBe(1);
    expect(door.texts.some((text) => text.includes('night_before_group'))).toBe(true);
    expect(driverSends[0]).toContain('night_before_driver');
    const [row] = await db.database
      .select()
      .from(schema.linqGroupCarpools)
      .where(eq(schema.linqGroupCarpools.familyId, familyId));
    expect(row?.reminderStatus).toBe('sent');
  });

  it('a driver who never texted Hale 1:1 gets no 1:1, even in a household group (no cold text)', async () => {
    const { familyId, userId } = await seed();
    await seedRoster(familyId, 'confirmed', PARENTS);
    const door = send();
    await insertAssigned(familyId, userId);
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: null })
      .where(eq(schema.families.id, familyId));
    const driverSends: string[] = [];
    const fired = await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door.send,
      voice: fakeCarpoolComposer(),
      listChatHandles: present(MOM, DAD),
      sendDriver: async ({ text }) => {
        driverSends.push(text);
        return { sent: true, providerMessageId: 'driver-1' };
      },
    });
    expect(fired.fired).toBe(1);
    expect(door.texts.some((text) => text.includes('night_before_group'))).toBe(true);
    expect(driverSends).toEqual([]);
  });

  it('does not send after quiet hours close the window', async () => {
    const { familyId, userId } = await seed();
    const voice = fakeCarpoolComposer();
    const door = send();
    await insertAssigned(familyId, userId, 'chat-quiet');
    const quiet = await runCarpoolReminders(db.database, {
      now: new Date('2026-10-10T01:30:00.000Z'),
      send: door.send,
      voice,
    });
    expect(quiet.fired).toBe(0);
    expect(door.texts).toEqual([]);
  });
});
