import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  loadAffectedDrivers,
  reanchorCarpoolReminders,
} from '~/lib/integrations/team-schedule/driver';
import { carpoolChatAudience, runCarpoolReminders } from './carpool';
import type { CarpoolReading } from './carpool-apply';
import { fakeCarpoolComposer } from './carpool-voice';
import type { PrivateAsideModel } from './group-private-aside';
import { handleLinqGroupMessage } from './inbound';
import type { SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

/**
 * VIL-689 · scene 06 in a chat several families share. Only a Hale family member in the
 * chat changes a ride; a driver, kids, event or place is kept only when the chat says it;
 * a group line never carries a household's private term the chat has not said; the
 * night-before reminder goes 1:1 to a driver who is a Hale customer and has texted Hale.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-shared-carpool';
const NOW = new Date('2026-11-12T16:00:00.000Z');
const PARENT_A = '+15555550111';
const PARENT_B = '+15555550122';
const GUEST = '+15555550199';
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
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_carpools, linq_group_rosters, family_events, audit_log, channel_messages cascade',
  );
});

async function seedFamily(phone: string, name: string, kid: string) {
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
  await db.database
    .insert(schema.children)
    .values({ familyId, name: kid, dateOfBirth: '2021-03-01' });
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
  return { familyId, userId };
}

function ride(partial: Partial<CarpoolReading>): CarpoolReading {
  return {
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
    ...partial,
  };
}

const chatter: SharedGroupReader = {
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

async function say(
  text: string,
  from: string,
  id: string,
  reading: CarpoolReading,
  voice = fakeCarpoolComposer(),
) {
  const group: string[] = [];
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
      listChatHandles: async () => ({ status: 'ok', handles: [PARENT_A, PARENT_B] }),
      sharedGroupReader: chatter,
      sharedGroupVoice: fakeSharedGroupComposer({ body: 'shared-reply-line' }),
      privateAsideModel: noAside,
      carpoolReader: { read: async () => reading },
      carpoolVoice: voice,
    } as unknown as Parameters<typeof handleLinqGroupMessage>[0],
    {
      messageId: id,
      chatId: CHAT,
      senderHandle: from,
      text,
      mediaCount: 0,
      receivedAt: NOW,
      otherHandles: [PARENT_A, PARENT_B].filter((handle) => handle !== from),
      mentions: [],
      isGroup: true,
    },
  );
  return { body: (await response.json()) as Record<string, unknown>, group };
}

async function rides() {
  return db.database.select().from(schema.linqGroupCarpools);
}

describe('a ride in a shared chat', () => {
  it("another family's parent claims a drive: the ride is theirs, with what the chat said", async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    const b = await seedFamily(PARENT_B, 'Bao', 'Mia');
    const out = await say(
      "I'll drive soccer Tuesday 5:30, taking Mia",
      PARENT_B,
      'm1',
      ride({ kids: 'Mia' }),
    );
    const [row] = await rides();
    expect(row?.driverUserId).toBe(b.userId);
    expect(row?.driverHaleCustomer).toBe('true');
    expect(row?.kids).toBe('Mia');
    expect(row?.eventLabel).toBe('soccer');
    expect(row?.reminderStatus).toBe('pending');
    expect(out.group).toEqual([]);
  });

  it('kids the chat never named are not kept', async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await seedFamily(PARENT_B, 'Bao', 'Mia');
    await say("I'll drive soccer Tuesday 5:30", PARENT_B, 'm1', ride({ kids: 'Zephyrina' }));
    const [row] = await rides();
    expect(row?.kids).toBeNull();
  });

  it('a driver the chat never named records nothing', async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await seedFamily(PARENT_B, 'Bao', 'Mia');
    await say(
      'someone is driving soccer Tuesday 5:30',
      PARENT_B,
      'm1',
      ride({ driverName: 'Priya', driverIsSender: false }),
    );
    expect(await rides()).toEqual([]);
  });

  it('a guest with no Hale family changes nothing', async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await seedFamily(PARENT_B, 'Bao', 'Mia');
    await say("I'll drive soccer Tuesday 5:30", GUEST, 'm1', ride({}));
    expect(await rides()).toEqual([]);
  });

  it("an ask for a driver that repeats another family's private term stays out of the group", async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await seedFamily(PARENT_B, 'Bao', 'Mia');
    const leaky = fakeCarpoolComposer('Who can drive Zephyrina to soccer Tuesday?');
    const out = await say(
      'who can drive to soccer Tuesday 5:30?',
      PARENT_B,
      'm1',
      ride({ intent: 'plan_needs_driver', driverIsSender: false }),
      leaky,
    );
    expect(out.group).toEqual([]);
    const unsent = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'group_line_unsent'));
    expect(unsent.map((row) => (row.after as { why: string }).why)).toEqual(['private_leak']);
  });

  it('a kid the chat itself named may be in the ask (positive control)', async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await seedFamily(PARENT_B, 'Bao', 'Mia');
    const voice = fakeCarpoolComposer('Who can drive Mia to soccer Tuesday?');
    const out = await say(
      'who can drive Mia to soccer Tuesday 5:30?',
      PARENT_B,
      'm1',
      ride({ intent: 'plan_needs_driver', driverIsSender: false, kids: 'Mia' }),
      voice,
    );
    expect(out.group).toEqual(['Who can drive Mia to soccer Tuesday?']);
    expect(out.body.outcome).toBe('carpool_asked');
  });
});

describe("a shared ride is never another family's private event data", () => {
  const TUESDAY_HOCKEY = new Date('2026-11-17T23:00:00.000Z');

  async function hockeyFor(familyId: string) {
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId,
        title: 'hockey',
        startsAt: TUESDAY_HOCKEY,
        location: 'Arena 1',
        source: 'email',
      })
      .returning({ id: schema.familyEvents.id });
    return event?.id as string;
  }

  it("is kept under the driver's own family, and a team-schedule change on the host family's event neither finds its driver nor moves it", async () => {
    const a = await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    const b = await seedFamily(PARENT_B, 'Bao', 'Mia');
    await say("I'll drive soccer Tuesday 5:30, taking Mia", PARENT_B, 'm1', ride({ kids: 'Mia' }));
    const [before] = await rides();
    expect(before?.familyId).toBe(b.familyId);

    for (const familyId of [a.familyId, b.familyId]) {
      const eventId = await hockeyFor(familyId);
      expect(
        await loadAffectedDrivers(db.database, {
          familyId,
          familyEventId: eventId,
          originalStartsAt: TUESDAY_HOCKEY,
          timeZone: 'America/Toronto',
        }),
      ).toEqual([]);
      await reanchorCarpoolReminders(db.database, {
        familyId,
        originalStartsAt: TUESDAY_HOCKEY,
        newStartsAt: new Date('2026-11-18T00:30:00.000Z'),
        newLocation: 'Arena 2',
        cancelled: false,
        timeZone: 'America/Toronto',
        now: NOW,
      });
    }
    const [after] = await rides();
    expect(after?.pickupAt?.toISOString()).toBe(before?.pickupAt?.toISOString());
    expect(after?.pickupPlace).toBe(before?.pickupPlace);
    expect(after?.reminderFireAt?.toISOString()).toBe(before?.reminderFireAt?.toISOString());
  });

  it("a ride in the family's own claimed household chat is still found and moved (positive control)", async () => {
    const a = await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-ada-household' })
      .where(eq(schema.families.id, a.familyId));
    await db.database.insert(schema.linqGroupCarpools).values({
      chatId: 'chat-ada-household',
      familyId: a.familyId,
      planKey: 'hockey:2026-11-17',
      eventLabel: 'hockey',
      pickupAt: TUESDAY_HOCKEY,
      driverName: 'Ada',
      driverUserId: a.userId,
      driverHaleCustomer: 'true',
      status: 'assigned',
      reminderStatus: 'pending',
    });
    const eventId = await hockeyFor(a.familyId);
    expect(
      await loadAffectedDrivers(db.database, {
        familyId: a.familyId,
        familyEventId: eventId,
        originalStartsAt: TUESDAY_HOCKEY,
        timeZone: 'America/Toronto',
      }),
    ).toEqual([{ userId: a.userId }]);
    await reanchorCarpoolReminders(db.database, {
      familyId: a.familyId,
      originalStartsAt: TUESDAY_HOCKEY,
      newStartsAt: new Date('2026-11-18T00:30:00.000Z'),
      newLocation: 'Arena 2',
      cancelled: false,
      timeZone: 'America/Toronto',
      now: NOW,
    });
    const [moved] = await rides();
    expect(moved?.pickupPlace).toBe('Arena 2');
  });
});

describe("team-schedule reads only the rides in a family's own household chats", () => {
  it('a family with a claimed chat does not reach a shared-chat ride filed under its id', async () => {
    const a = await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    const b = await seedFamily(PARENT_B, 'Bao', 'Mia');
    const tuesday = new Date('2026-11-17T23:00:00.000Z');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-ada-household' })
      .where(eq(schema.families.id, a.familyId));
    // A ride in the chat both families share, filed under Ada's family, driven by Bao.
    await db.database.insert(schema.linqGroupCarpools).values({
      chatId: CHAT,
      familyId: a.familyId,
      planKey: 'soccer:2026-11-17',
      eventLabel: 'soccer',
      pickupAt: tuesday,
      driverName: 'Bao',
      driverUserId: b.userId,
      driverHaleCustomer: 'true',
      status: 'assigned',
      reminderStatus: 'pending',
    });
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({ familyId: a.familyId, title: 'hockey', startsAt: tuesday, source: 'email' })
      .returning({ id: schema.familyEvents.id });
    expect(
      await loadAffectedDrivers(db.database, {
        familyId: a.familyId,
        familyEventId: event?.id as string,
        originalStartsAt: tuesday,
        timeZone: 'America/Toronto',
      }),
    ).toEqual([]);
  });
});

describe('household or shared is decided once, from positive proof', () => {
  const STATUSES = [
    'roster_pending',
    'no_family',
    'mixed_family',
    'roles_proposed',
    'partial',
    'confirmed',
    'refused',
    'ejected',
    'not_group',
  ] as const;
  const HOUSEHOLD = new Set<string>(['confirmed', 'roles_proposed']);

  async function familyOnly(name: string) {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: name, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    return family?.id as string;
  }

  for (const status of STATUSES) {
    it(`a roster in ${status} with a family and no live join is ${HOUSEHOLD.has(status) ? 'a household' : 'shared'}`, async () => {
      const familyId = await familyOnly('Ada');
      await db.database
        .insert(schema.linqGroupRosters)
        .values({ chatId: CHAT, familyId, source: 'added_to_existing', status });
      expect(await carpoolChatAudience(db.database, CHAT)).toBe(
        HOUSEHOLD.has(status) ? 'household' : 'shared',
      );
    });
  }

  it('a confirmed roster with no family is shared', async () => {
    await db.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: CHAT, familyId: null, source: 'added_to_existing', status: 'confirmed' });
    expect(await carpoolChatAudience(db.database, CHAT)).toBe('shared');
  });

  it('a confirmed household roster with a live multi-family join is shared', async () => {
    const a = await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    await db.database.insert(schema.linqGroupRosters).values({
      chatId: CHAT,
      familyId: a.familyId,
      source: 'added_to_existing',
      status: 'confirmed',
    });
    expect(await carpoolChatAudience(db.database, CHAT)).toBe('shared');
  });

  it('no roster at all is shared', async () => {
    expect(await carpoolChatAudience(db.database, CHAT)).toBe('shared');
  });

  it('a ride keeps the decision it was made with: a roster confirmed later never turns its reminder into a group line or a cold 1:1', async () => {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    const b = await seedFamily(PARENT_B, 'Bao', 'Mia');
    await say("I'll drive soccer Tuesday 5:30, taking Mia", PARENT_B, 'm1', ride({ kids: 'Mia' }));
    const [row] = await rides();
    expect(row?.chatAudience).toBe('shared');
    // Later the chat's joins end and a confirmed household roster appears.
    await db.database.update(schema.linqMultiFamilyJoins).set({ leftAt: NOW });
    await db.database.insert(schema.linqGroupRosters).values({
      chatId: CHAT,
      familyId: b.familyId,
      source: 'added_to_existing',
      status: 'confirmed',
    });
    expect(await carpoolChatAudience(db.database, CHAT)).toBe('household');
    const group: string[] = [];
    const driver: string[] = [];
    await runCarpoolReminders(db.database, {
      now: new Date((row?.reminderFireAt as Date).getTime() + 5 * 60 * 1000),
      send: async ({ text }) => {
        group.push(text);
        return { providerMessageId: `g-${group.length}` };
      },
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ text }) => {
        driver.push(text);
        return { sent: true, providerMessageId: 'driver-1' };
      },
    });
    expect(group).toEqual([]);
    expect(driver).toEqual([]);
  });
});

describe('the night-before reminder for a shared ride', () => {
  async function dueRide(texted: boolean) {
    await seedFamily(PARENT_A, 'Ada', 'Zephyrina');
    const b = await seedFamily(PARENT_B, 'Bao', 'Mia');
    if (texted) {
      await db.database.insert(schema.channelMessages).values({
        familyId: b.familyId,
        parentUserId: b.userId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerChatId: 'dm-bao',
        inGroup: false,
        status: 'delivered',
        sentAt: NOW,
      });
    }
    await say("I'll drive soccer Tuesday 5:30, taking Mia", PARENT_B, 'm1', ride({ kids: 'Mia' }));
    const [row] = await rides();
    return { row, b };
  }

  async function remind(fireAt: Date) {
    const group: string[] = [];
    const driver: string[] = [];
    const ran = await runCarpoolReminders(db.database, {
      now: new Date(fireAt.getTime() + 5 * 60 * 1000),
      send: async ({ text }) => {
        group.push(text);
        return { providerMessageId: `g-${group.length}` };
      },
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ text }) => {
        driver.push(text);
        return { sent: true, providerMessageId: 'driver-1' };
      },
    });
    return { ran, group, driver };
  }

  it('goes 1:1 to a driver who has texted Hale, and never to the group', async () => {
    const { row } = await dueRide(true);
    const out = await remind(row?.reminderFireAt as Date);
    expect(out.group).toEqual([]);
    expect(out.driver).toHaveLength(1);
    expect(out.driver[0]).toContain('night_before_driver');
  });

  it('a driver who never texted Hale gets nothing, and neither does the group', async () => {
    const { row } = await dueRide(false);
    const out = await remind(row?.reminderFireAt as Date);
    expect(out.group).toEqual([]);
    expect(out.driver).toEqual([]);
  });
});
