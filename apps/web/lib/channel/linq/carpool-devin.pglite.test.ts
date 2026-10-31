import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  classifyDriverSendError,
  considerCarpoolTapback,
  considerCarpoolTurn,
  createCarpoolDriverSend,
  runCarpoolReminders,
} from './carpool';
import type { CarpoolReading } from './carpool-apply';
import type { CarpoolReadInput } from './carpool-reading';
import { createCarpoolComposer, fakeCarpoolComposer } from './carpool-voice';
import { LinqSendError } from './transport';

vi.mock('~/lib/monitoring/ops-slack', () => ({ postOpsSlack: async () => 'skipped' }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({ instructions: '', meta: { task: 'reply' } }),
}));
vi.mock('@hale/agent', async (orig) => ({ ...((await orig()) as object), pickLane: () => 'hot' }));
vi.mock('~/lib/pipeline/client', () => ({
  budgetedAnthropic: () => ({}),
  HOT_SMS_CLIENT_OPTIONS: {},
}));
// The model "invents" a driver and place that are not in the facts.
vi.mock('~/lib/pipeline/structured', () => ({
  forceToolJson: async () => ({ value: { line: 'Bob drives everyone from the mall at 9' } }),
}));

/** VIL-517 — one test per Devin finding on merged #936. Fake family; nothing leaves. */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-08T16:00:00.000Z');
const FRIDAY_EVE = new Date('2026-10-09T22:00:00.000Z');
const CHAT = 'chat-carpool-517';
const SAT = '2026-10-10T12:00:00.000Z';
const SUN = '2026-10-11T13:00:00.000Z';
const MAYA_PHONE = '+14165550111';
const PRIYA_PHONE = '+14165550113';
const STRANGER = '+14165550199';

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
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_group_carpools, linq_group_members, audit_log, channel_messages, family_members, families, users cascade',
  );
});

async function seed() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const [maya] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:maya', name: 'Maya Chen', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const mayaId = maya?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: mayaId, role: 'primary_parent' });
  return { familyId, mayaId };
}

async function seatPriya(familyId: string) {
  const [priya] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:priya', name: 'Priya Shah', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId: priya?.id as string,
    phoneE164Encrypted: encryptString(PRIYA_PHONE),
    phoneE164Hash: phoneBlindIndex(PRIYA_PHONE),
    role: 'caregiver',
  });
  return priya?.id as string;
}

/** Design (#975) — the driver 1:1 only runs for a family with no claimed group. */
async function unclaimGroup(familyId: string) {
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: null })
    .where(eq(schema.families.id, familyId));
}

function door() {
  const texts: string[] = [];
  return {
    texts,
    send: async (notice: { chatId: string; text: string }) => {
      texts.push(notice.text);
      return { providerMessageId: `preview-${texts.length}` };
    },
  };
}

function reading(over: Partial<CarpoolReading>): CarpoolReading {
  return {
    intent: 'driver_claim',
    driverName: null,
    eventLabel: 'soccer',
    pickupAtIso: SAT,
    pickupPlace: 'the rec',
    kids: 'Noah',
    confidence: 'high',
    ...over,
  };
}

function turn(
  familyId: string,
  r: CarpoolReading,
  who: { handle: string; userId: string | null; name: string | null },
  extra: Partial<Parameters<typeof considerCarpoolTurn>[1]> = {},
) {
  return considerCarpoolTurn(db.database, {
    chatId: CHAT,
    familyId,
    senderHandle: who.handle,
    senderUserId: who.userId,
    senderName: who.name,
    text: 'x',
    now: NOW,
    send: door().send,
    voice: fakeCarpoolComposer(),
    reader: { read: async () => r },
    ...extra,
  });
}

async function rows() {
  return db.database.select().from(schema.linqGroupCarpools);
}

describe('security', () => {
  it('1: an unknown sender cannot claim or cancel a ride', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const claim = await turn(familyId, reading({ intent: 'driver_swap', driverName: 'Eve' }), {
      handle: STRANGER,
      userId: null,
      name: 'Eve',
    });
    const cancel = await turn(familyId, reading({ intent: 'cancel' }), {
      handle: STRANGER,
      userId: null,
      name: null,
    });
    expect(claim).toEqual({ handled: false, outcome: 'unknown_sender' });
    expect(cancel).toEqual({ handled: false, outcome: 'unknown_sender' });
    const [row] = await rows();
    expect(row?.driverName).toBe('Maya');
    expect(row?.cancelledAt).toBeNull();
    expect(row?.reminderStatus).toBe('pending');
  });

  it('2: a ride reminder is held, not sent as a reply, when the roster is incomplete', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const group = door();
    const ran = await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: group.send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => ({ sent: false, skipped: 'test' }),
    });
    expect(ran.fired).toBe(0);
    expect(group.texts).toEqual([]);
    const [row] = await rows();
    expect(row?.reminderStatus).toBe('pending');
  });
});

describe('reminder bugs', () => {
  it('3: a noncustomer driver reminder ledgers under the family parent and is not repeated', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Grandma Lin' }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const group = door();
    const run = () =>
      runCarpoolReminders(db.database, {
        now: FRIDAY_EVE,
        send: group.send,
        voice: fakeCarpoolComposer(),
        sendDriver: async () => ({ sent: false, skipped: 'test' }),
      });
    expect((await run()).fired).toBe(1);
    expect((await run()).fired).toBe(0);
    expect(group.texts).toHaveLength(1);
    const ledger = await db.database.select().from(schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.parentUserId).toBe(mayaId);
  });

  it('3: a ledger failure after the group send does not replay the reminder', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const group = door();
    const original = db.database.insert.bind(db.database);
    const spy = vi.spyOn(db.database, 'insert').mockImplementation(((table: unknown) => {
      if (table === schema.channelMessages) throw new Error('ledger down');
      return original(table as never);
    }) as never);
    try {
      await runCarpoolReminders(db.database, {
        now: FRIDAY_EVE,
        send: group.send,
        voice: fakeCarpoolComposer(),
        sendDriver: async () => ({ sent: false, skipped: 'test' }),
      });
      await runCarpoolReminders(db.database, {
        now: FRIDAY_EVE,
        send: group.send,
        voice: fakeCarpoolComposer(),
        sendDriver: async () => ({ sent: false, skipped: 'test' }),
      });
    } finally {
      spy.mockRestore();
    }
    expect(group.texts).toHaveLength(1);
  });

  it('4: without an injected sendDriver the production driver send runs (gated, nothing sent)', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const voice = fakeCarpoolComposer();
    await runCarpoolReminders(db.database, { now: FRIDAY_EVE, send: door().send, voice });
    expect(voice.calls.map((call) => call.kind)).toContain('night_before_driver');
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_carpool_reminder_sent'));
    const after = audits[0]?.after as { driverSkipped: string | null };
    expect(after.driverSkipped).not.toBe('no_driver_send');
    expect(after.driverSkipped).toBe('not_enrolled');
  });

  it('4: the production driver send refuses a user with no family', async () => {
    const [lone] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'imessage:lone', name: 'Lone' })
      .returning({ id: schema.users.id });
    const send = createCarpoolDriverSend(db.database, FRIDAY_EVE);
    expect(await send({ userId: lone?.id as string, text: 'hi' })).toEqual({
      sent: false,
      skipped: 'no_family',
    });
  });

  it('5: a tapback on the ask resolves the reactor from their handle and claims the drive', async () => {
    const { familyId, mayaId } = await seed();
    const priyaId = await seatPriya(familyId);
    const asked = await turn(
      familyId,
      reading({ intent: 'plan_needs_driver' }),
      { handle: MAYA_PHONE, userId: mayaId, name: 'Maya' },
      { addressed: true },
    );
    expect(asked).toMatchObject({ outcome: 'carpool_asked' });
    const [before] = await rows();
    const result = await considerCarpoolTapback(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: PRIYA_PHONE,
      senderName: null,
      messageId: before?.askMessageId as string,
      reactionType: 'love',
      now: NOW,
      send: door().send,
      voice: fakeCarpoolComposer(),
    });
    expect(result.handled).toBe(true);
    const [row] = await rows();
    expect(row?.driverName).toBe('Priya');
    expect(row?.driverUserId).toBe(priyaId);
  });

  it('6: the reader sees the recent group transcript', async () => {
    const { familyId, mayaId } = await seed();
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: mayaId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'in-1',
      providerChatId: CHAT,
      status: 'delivered',
      body: 'Soccer Sat 8am at the rec, who can drive?',
      sentAt: new Date(NOW.getTime() - 60_000),
    });
    const seen: CarpoolReadInput[] = [];
    await considerCarpoolTurn(db.database, {
      chatId: CHAT,
      familyId,
      senderHandle: MAYA_PHONE,
      senderUserId: mayaId,
      senderName: 'Maya',
      text: 'I can drive',
      messageId: 'in-2',
      now: NOW,
      send: door().send,
      voice: fakeCarpoolComposer(),
      reader: {
        read: async (input) => {
          seen.push(input);
          return reading({ driverName: 'Maya', driverIsSender: true });
        },
      },
    });
    expect(seen[0]?.recent).toEqual([
      { from: 'member', text: 'Soccer Sat 8am at the rec, who can drive?' },
    ]);
  });

  it('7: two rides in one chat keep their own rows', async () => {
    const { familyId, mayaId } = await seed();
    const maya = { handle: MAYA_PHONE, userId: mayaId, name: 'Maya' };
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), maya);
    await turn(
      familyId,
      reading({
        eventLabel: 'swim',
        pickupAtIso: SUN,
        pickupPlace: 'the pool',
        driverName: 'Maya',
      }),
      maya,
    );
    const all = await rows();
    expect(all).toHaveLength(2);
    const soccer = all.find((row) => row.eventLabel === 'soccer');
    const swim = all.find((row) => row.eventLabel === 'swim');
    expect(soccer?.pickupPlace).toBe('the rec');
    expect(swim?.pickupPlace).toBe('the pool');
    // A message naming neither ride changes nothing.
    const vague = await turn(
      familyId,
      reading({ eventLabel: null, pickupAtIso: null, intent: 'cancel' }),
      maya,
    );
    expect(vague).toEqual({ handled: false, outcome: 'unchanged' });
    expect((await rows()).every((row) => row.cancelledAt === null)).toBe(true);
  });

  it('8: overlapping cron runs send one reminder', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Grandma Lin' }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const group = door();
    const opts = {
      now: FRIDAY_EVE,
      send: group.send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => ({ sent: false as const, skipped: 'test' }),
    };
    const [a, b] = await Promise.all([
      runCarpoolReminders(db.database, opts),
      runCarpoolReminders(db.database, opts),
    ]);
    expect(a.fired + b.fired).toBe(1);
    expect(group.texts).toHaveLength(1);
  });

  it('9: "Priya is driving" from Maya does not carry Maya\'s account', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Priya' }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const [row] = await rows();
    expect(row?.driverName).toBe('Priya');
    expect(row?.driverUserId).toBeNull();
    expect(row?.driverHaleCustomer).toBe('false');
  });

  it('10: a ride moved to a new day after its reminder gets a new pending reminder', async () => {
    const { familyId, mayaId } = await seed();
    const maya = { handle: MAYA_PHONE, userId: mayaId, name: 'Maya' };
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), maya);
    await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => ({ sent: false, skipped: 'test' }),
    });
    expect((await rows())[0]?.reminderStatus).toBe('sent');
    const moved = await turn(
      familyId,
      reading({
        intent: 'driver_claim',
        driverName: 'Maya',
        driverIsSender: true,
        pickupAtIso: SUN,
      }),
      maya,
    );
    expect(moved.handled).toBe(true);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.reminderStatus).toBe('pending');
    expect(all[0]?.pickupAt?.toISOString()).toBe(SUN);
    expect(all[0]?.reminderFireAt?.getTime()).toBeGreaterThan(FRIDAY_EVE.getTime());
  });
});

describe('composer', () => {
  it('11: without the database the line is refused, never sent ungrounded', async () => {
    const composer = createCarpoolComposer();
    expect(
      await composer.compose({
        kind: 'night_before_group',
        facts: {
          driver: 'Maya',
          kids: 'Noah',
          pickupTime: 'Sat 8:00 a.m.',
          pickupPlace: 'the rec',
          event: 'soccer',
          language: null,
        },
      }),
    ).toBeNull();
  });
});

/** VIL-517 — Devin's second pass on #975. Fake families; nothing leaves. */
describe('Devin #975', () => {
  async function otherFamilyMember() {
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Park', provinceOrState: 'ON', linqGroupChatId: 'chat-park' })
      .returning({ id: schema.families.id });
    const [eve] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'imessage:eve', name: 'Eve Park', timezone: 'America/Toronto' })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: other?.id as string, userId: eve?.id as string, role: 'primary_parent' });
    return eve?.id as string;
  }

  it('security: a verified member of another family cannot claim, swap, or cancel', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const eveId = await otherFamilyMember();
    const eve = { handle: STRANGER, userId: eveId, name: 'Eve' };
    const swap = await turn(
      familyId,
      reading({ intent: 'driver_swap', driverName: 'Eve', driverIsSender: true }),
      eve,
    );
    const cancel = await turn(familyId, reading({ intent: 'cancel' }), eve);
    expect(swap).toEqual({ handled: false, outcome: 'unknown_sender' });
    expect(cancel).toEqual({ handled: false, outcome: 'unknown_sender' });
    const [row] = await rows();
    expect(row?.driverName).toBe('Maya');
    expect(row?.driverUserId).toBe(mayaId);
    expect(row?.cancelledAt).toBeNull();
  });

  it('security: a seated roster member of this chat can still claim', async () => {
    const { familyId, mayaId } = await seed();
    const priyaId = await seatPriya(familyId);
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const swap = await turn(
      familyId,
      reading({ intent: 'driver_swap', driverName: 'Priya', driverIsSender: true }),
      { handle: PRIYA_PHONE, userId: null, name: 'Priya' },
    );
    expect(swap).toMatchObject({ handled: true, outcome: 'carpool_swapped' });
    const [row] = await rows();
    expect(row?.driverUserId).toBe(priyaId);
  });

  it('a failed driver 1:1 retries on the next sweep without resending the group', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const group = door();
    const driverCalls: string[] = [];
    let driverUp = false;
    const opts = () => ({
      now: FRIDAY_EVE,
      send: group.send,
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ userId }: { userId: string; text: string }) => {
        driverCalls.push(userId);
        return driverUp
          ? { sent: true as const, providerMessageId: 'driver-1' }
          : { sent: false as const, skipped: 'send_failed:unavailable' };
      },
    });
    const first = await runCarpoolReminders(db.database, opts());
    expect(first.fired).toBe(1);
    expect(driverCalls).toHaveLength(1);
    expect((await rows())[0]?.reminderDriverSentAt).toBeNull();

    driverUp = true;
    const second = await runCarpoolReminders(db.database, opts());
    expect(second.fired).toBe(0);
    expect(second.driverRetried).toBe(1);
    expect(driverCalls).toEqual([mayaId, mayaId]);
    expect(group.texts).toHaveLength(1);
    const [row] = await rows();
    expect(row?.reminderStatus).toBe('sent');
    expect(row?.reminderDriverSentAt).not.toBeNull();

    const third = await runCarpoolReminders(db.database, opts());
    expect(third.driverRetried).toBe(0);
    expect(driverCalls).toHaveLength(2);
    expect(group.texts).toHaveLength(1);
  });

  it('a driver retry stops once the pickup has passed', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const calls: string[] = [];
    const sendDriver = async ({ userId }: { userId: string; text: string }) => {
      calls.push(userId);
      return { sent: false as const, skipped: 'send_failed:unavailable' };
    };
    await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver,
    });
    await runCarpoolReminders(db.database, {
      now: new Date('2026-10-10T13:00:00.000Z'),
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver,
    });
    expect(calls).toHaveLength(1);
  });

  it('a date-only reschedule moves the only live ride instead of adding a second', async () => {
    const { familyId, mayaId } = await seed();
    const maya = { handle: MAYA_PHONE, userId: mayaId, name: 'Maya' };
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), maya);
    const moved = await turn(
      familyId,
      reading({ intent: 'driver_claim', driverName: null, eventLabel: null, pickupAtIso: SUN }),
      maya,
    );
    expect(moved.handled).toBe(true);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.eventLabel).toBe('soccer');
    expect(all[0]?.pickupAt?.toISOString()).toBe(SUN);
    expect(all[0]?.reminderStatus).toBe('pending');
    expect(all[0]?.reminderFireAt?.getTime()).toBeGreaterThan(FRIDAY_EVE.getTime());
  });

  it('a date-only reschedule with two live rides changes nothing', async () => {
    const { familyId, mayaId } = await seed();
    const maya = { handle: MAYA_PHONE, userId: mayaId, name: 'Maya' };
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), maya);
    await turn(
      familyId,
      reading({ eventLabel: 'swim', pickupAtIso: SUN, driverName: 'Maya', driverIsSender: true }),
      maya,
    );
    const vague = await turn(
      familyId,
      reading({ eventLabel: null, pickupAtIso: '2026-10-12T13:00:00.000Z' }),
      maya,
    );
    expect(vague).toEqual({ handled: false, outcome: 'unchanged' });
    expect(await rows()).toHaveLength(2);
  });

  it('a shared first name does not route the sender account to another driver', async () => {
    const { familyId } = await seed();
    const priyaId = await seatPriya(familyId);
    // Priya Shah names a different Priya (say, a neighbour) as the driver.
    await turn(familyId, reading({ driverName: 'Priya', driverIsSender: false }), {
      handle: PRIYA_PHONE,
      userId: priyaId,
      name: 'Priya',
    });
    const [row] = await rows();
    expect(row?.driverName).toBe('Priya');
    expect(row?.driverUserId).toBeNull();
    expect(row?.driverHaleCustomer).toBe('false');
  });

  it('a clear self-claim carries the sender account', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: null }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const [row] = await rows();
    expect(row?.driverName).toBe('Maya');
    expect(row?.driverUserId).toBe(mayaId);
  });
});

describe('Devin #975 round 2', () => {
  it('a compose that throws releases its claim and retries next sweep', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const group = door();
    let calls = 0;
    const sendDriver = async () => {
      calls += 1;
      return { sent: true as const, providerMessageId: 'driver-ok' };
    };
    const base = fakeCarpoolComposer();
    let composes = 0;
    const voice = {
      ...base,
      compose: async (req: Parameters<typeof base.compose>[0]) => {
        if (req.kind === 'night_before_driver' && composes++ === 0) throw new Error('model down');
        return base.compose(req);
      },
    };
    const opts = { now: FRIDAY_EVE, send: group.send, voice, sendDriver };
    await runCarpoolReminders(db.database, opts);
    expect((await rows())[0]?.reminderDriverSentAt).toBeNull();
    const second = await runCarpoolReminders(db.database, opts);
    expect(second.driverRetried).toBe(1);
    expect(calls).toBe(1);
    expect(group.texts).toHaveLength(1);
  });

  it('a stale failed leg does not clear a newer reminder generation', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const newer = new Date(FRIDAY_EVE.getTime() + 86_400_000);
    let calls = 0;
    await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => {
        calls += 1;
        // While this send is in flight the ride is re-reminded and its new
        // driver leg is delivered.
        await db.database
          .update(schema.linqGroupCarpools)
          .set({ reminderGroupSentAt: newer, reminderDriverSentAt: newer });
        return { sent: false, skipped: 'send_failed:unavailable' };
      },
    });
    const [row] = await rows();
    expect(calls).toBe(1);
    expect(row?.reminderDriverSentAt?.getTime()).toBe(newer.getTime());
  });
});

describe('Devin #975 round 3 + Design gate', () => {
  it('a driver send with an unknown outcome keeps its claim (no resend)', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    let calls = 0;
    const opts = {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => {
        calls += 1;
        throw new Error('ledger update after send failed');
      },
    };
    await runCarpoolReminders(db.database, opts);
    expect((await rows())[0]?.reminderDriverSentAt).not.toBeNull();
    await runCarpoolReminders(db.database, opts);
    expect(calls).toBe(1);
  });

  it('a send_unknown result keeps its claim too', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    let calls = 0;
    const opts = {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => {
        calls += 1;
        return { sent: false as const, skipped: 'send_unknown' };
      },
    };
    await runCarpoolReminders(db.database, opts);
    await runCarpoolReminders(db.database, opts);
    expect(calls).toBe(1);
  });

  it('(a) driver whose family group is claimed: no driver 1:1, group only', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    const group = door();
    const calls: string[] = [];
    const opts = {
      now: FRIDAY_EVE,
      send: group.send,
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ userId }: { userId: string; text: string }) => {
        calls.push(userId);
        return { sent: true as const, providerMessageId: 'x' };
      },
    };
    const ran = await runCarpoolReminders(db.database, opts);
    await runCarpoolReminders(db.database, opts);
    expect(ran.fired).toBe(1);
    expect(group.texts).toHaveLength(1);
    expect(calls).toEqual([]);
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_carpool_reminder_sent'));
    expect((audits[0]?.after as { driverSkipped: string }).driverSkipped).toBe(
      'driver_group_claimed',
    );
  });

  it('(b) driver with no claimed group: driver 1:1 is sent', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    const calls: string[] = [];
    await runCarpoolReminders(db.database, {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async ({ userId }: { userId: string; text: string }) => {
        calls.push(userId);
        return { sent: true as const, providerMessageId: 'x' };
      },
    });
    expect(calls).toEqual([mayaId]);
    expect((await rows())[0]?.reminderDriverSentAt).not.toBeNull();
  });
});

describe('Devin #975 round 4', () => {
  it('timeouts, network drops, missing ids and unknown errors are not proof of non-send', () => {
    for (const code of ['timeout', 'network', 'missing_message_id']) {
      expect(classifyDriverSendError(new LinqSendError(code, 0, false))).toEqual({
        kind: 'unknown',
        code,
      });
    }
    expect(classifyDriverSendError(new Error('boom')).kind).toBe('unknown');
  });

  it('a recognised provider refusal is a definite non-send', () => {
    expect(classifyDriverSendError(new LinqSendError('not_configured', 0, true))).toEqual({
      kind: 'refused',
      code: 'not_configured',
    });
  });

  it('a send_unknown:<code> result keeps the claim', async () => {
    const { familyId, mayaId } = await seed();
    await turn(familyId, reading({ driverName: 'Maya', driverIsSender: true }), {
      handle: MAYA_PHONE,
      userId: mayaId,
      name: 'Maya',
    });
    await unclaimGroup(familyId);
    let calls = 0;
    const opts = {
      now: FRIDAY_EVE,
      send: door().send,
      voice: fakeCarpoolComposer(),
      sendDriver: async () => {
        calls += 1;
        return { sent: false as const, skipped: 'send_unknown:timeout' };
      },
    };
    await runCarpoolReminders(db.database, opts);
    await runCarpoolReminders(db.database, opts);
    expect(calls).toBe(1);
  });
});
