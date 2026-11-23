import { createHash } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_SCOPED_SEND_KEYS_ENV } from '~/lib/channel/family-send-key';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { PROACTIVE_CADENCE_ENV } from '~/lib/channel/proactive/flag';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedIntegration } from '~/lib/testing/pglite';
import { sweepDutyAsks } from './asks';
import {
  COPARENT_DUTY_MEMORY_ENABLED_ENV,
  COPARENT_DUTY_SENDS_ENABLED_ENV,
  COPARENT_SPLIT_DUTY_ENABLED_ENV,
} from './flag';
import { commitDutyUpdate } from './model';
import { type OpenDutyFact, dutySendScope, settleStrandedDutySends } from './send-receipt';

/**
 * Two households holding one calendar event id, through the real sweep, gate, target and
 * Linq transport. Only `fetch` is stubbed. The writer is a scripted stand-in, because these
 * tests pin which keys go out and the wording is graded by the duty evals.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** Sunday 27 Sep 2026, 18:00 in Toronto: inside the night-before window. */
const EVENING = new Date('2026-09-27T22:00:00.000Z');
/** Sunday 27 Sep 2026, 15:00 in Toronto. */
const AFTERNOON = new Date('2026-09-27T19:00:00.000Z');
const MONDAY = new Date('2026-09-28T19:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const SHARED_EVENT = 'evt-shared-coach-invite';
const SPLIT_TEXT = 'Who drives Robin to hockey and who drives Casey to dance?';
const linqKey = (sendKey: string) => createHash('sha256').update(sendKey).digest('hex');

interface Household {
  chatId: string | null;
  phones: readonly [string, string];
}

const HOUSE_A: Household = { chatId: 'chat-duty-a', phones: ['+15555550201', '+15555550202'] };
const HOUSE_B: Household = { chatId: 'chat-duty-b', phones: ['+15555550203', '+15555550204'] };
const DIRECT_A: Household = { chatId: null, phones: ['+15555550205', '+15555550206'] };
const DIRECT_B: Household = { chatId: null, phones: ['+15555550207', '+15555550208'] };

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
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', '+15555550200');
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
  vi.stubEnv(PROACTIVE_CADENCE_ENV, 'off');
  vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
  vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
  vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, linq_group_rosters cascade');
});

interface WirePost {
  to: string;
  key: string;
}

/** Linq as its docs state it: a seen key answers the first response and adds no bubble. */
function linqWire(households: readonly Household[]) {
  const posts: WirePost[] = [];
  const bubbles = new Map<string, string>();
  const directChats = new Map<string, string>();
  let failNext = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(String(url));
    const group = households.find((row) => row.chatId && pathname.includes(`/${row.chatId}`));
    if (init?.method === 'GET') {
      if (group) {
        return Response.json({
          chat: {
            id: group.chatId,
            is_group: true,
            handles: group.phones.map((handle) => ({ handle })),
          },
        });
      }
      const chatId = directChats.get(searchParams.get('to') ?? '');
      return Response.json({ chats: chatId ? [{ id: chatId, is_group: false }] : [] });
    }
    const body = JSON.parse(String(init?.body)) as {
      to?: string[];
      message: { idempotency_key: string };
    };
    const direct =
      body.to?.[0] ?? [...directChats].find(([, id]) => pathname.includes(`/${id}/`))?.[0];
    const to = group?.chatId ?? direct;
    if (!to) throw new Error(`unexpected wire call: ${pathname}`);
    const key = body.message.idempotency_key;
    posts.push({ to, key });
    const messageId = bubbles.get(key) ?? `linq-${bubbles.size + 1}`;
    bubbles.set(key, messageId);
    if (!group && !directChats.has(to)) directChats.set(to, `chat-direct-${directChats.size + 1}`);
    if (failNext > 0) {
      failNext -= 1;
      return new Response(JSON.stringify({ error: { code: 500 } }), { status: 500 });
    }
    return Response.json(
      pathname.endsWith('/messages')
        ? { message: { id: messageId } }
        : { chat: { id: directChats.get(to), message: { id: messageId } } },
      { status: 201 },
    );
  });
  vi.stubGlobal('fetch', fetchImpl);
  return {
    posts,
    /** Each distinct idempotency key that reached this recipient is one bubble. */
    bubblesTo: (to: string) => new Set(posts.filter((p) => p.to === to).map((p) => p.key)).size,
    failNextPosts: (count: number) => {
      failNext = count;
    },
  };
}

interface Seeded extends Household {
  familyId: string;
  parentUserId: string;
  secondUserId: string;
}

async function seedHousehold(household: Household, childAt: Date): Promise<Seeded> {
  const [first, second] = household.phones;
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Test household',
      provinceOrState: 'ON',
      postalCode: 'M5V2T6',
      linqGroupChatId: household.chatId,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const users = await db.database
    .insert(schema.users)
    .values(
      ['primary', 'coparent'].map((who) => ({
        externalAuthId: `sms:${who}-${familyId}`,
        name: who === 'primary' ? 'Riley' : 'Sam',
        timezone: 'America/Toronto',
      })),
    )
    .returning({ id: schema.users.id, name: schema.users.name });
  const parentUserId = users.find((row) => row.name === 'Riley')?.id as string;
  const secondUserId = users.find((row) => row.name === 'Sam')?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: parentUserId, role: 'primary_parent' },
    { familyId, userId: secondUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values(
    [
      { userId: parentUserId, phone: first },
      { userId: secondUserId, phone: second },
    ].map(({ userId, phone }) => ({
      userId,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date(childAt.getTime() - 24 * HOUR_MS),
    })),
  );
  await db.database.insert(schema.consentRecords).values(
    [parentUserId, secondUserId].map((userId) => ({
      userId,
      familyId,
      consentType: 'proactive_watch' as const,
      granted: true,
      consentScope: WATCH_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'yes please' },
    })),
  );
  if (household.chatId) {
    const [roster] = await db.database
      .insert(schema.linqGroupRosters)
      .values({
        chatId: household.chatId,
        familyId,
        source: 'added_to_existing',
        status: 'confirmed',
      })
      .returning({ id: schema.linqGroupRosters.id });
    await db.database.insert(schema.linqGroupRosterMembers).values([
      {
        rosterId: roster?.id as string,
        chatId: household.chatId,
        phoneE164Hash: phoneBlindIndex(first),
        knownUserId: parentUserId,
        status: 'known_parent',
      },
      {
        rosterId: roster?.id as string,
        chatId: household.chatId,
        phoneE164Hash: phoneBlindIndex(second),
        userId: secondUserId,
        status: 'confirmed',
        confirmedRole: 'co_parent',
      },
    ]);
  }
  return { ...household, familyId, parentUserId, secondUserId };
}

async function block(
  family: Seeded,
  integrationId: string,
  eventId: string,
  title: string,
  childId: string | null,
) {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId,
    eventId,
    familyId: family.familyId,
    userId: family.parentUserId,
    startAt: MONDAY,
    endAt: new Date(MONDAY.getTime() + HOUR_MS),
    kidRelated: true,
    title,
    calendarStanding: 'organizer',
    childId,
    status: 'confirmed',
    updatedStamp: '1',
  });
}

async function nightBeforeHousehold(household: Household): Promise<Seeded> {
  const family = await seedHousehold(household, EVENING);
  await seedChild(db.database, family.familyId, 'Robin', 36, undefined, EVENING);
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  await block(family, integrationId, SHARED_EVENT, 'Robin swim', null);
  await commitDutyUpdate(db.database, {
    mode: 'write',
    familyId: family.familyId,
    actorUserId: family.parentUserId,
    parentCount: 2,
    subjectKey: SHARED_EVENT,
    eventTitle: 'Robin swim',
    childNames: ['Robin'],
    slot: { role: 'pickup', claim: 'self', name: null, userId: family.parentUserId, confidence: 1 },
    prior: null,
    source: 'text',
    now: EVENING,
    childId: null,
    question: false,
    askWhichKid: false,
  });
  return family;
}

async function splitHousehold(household: Household): Promise<Seeded> {
  const family = await seedHousehold(household, AFTERNOON);
  const robin = await seedChild(db.database, family.familyId, 'Robin', 36, undefined, AFTERNOON);
  const casey = await seedChild(db.database, family.familyId, 'Casey', 48, undefined, AFTERNOON);
  const integrationId = await seedIntegration(
    db.database,
    family.familyId,
    family.parentUserId,
    'gcal',
  );
  await block(family, integrationId, `${SHARED_EVENT}-hockey`, 'Robin hockey', robin);
  await block(family, integrationId, `${SHARED_EVENT}-dance`, 'Casey dance', casey);
  return family;
}

function scriptedWriter(text: string): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ text }) }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      })),
    },
  } as unknown as AgentClient;
}

const nightSweep = (now: Date) =>
  sweepDutyAsks(db.database, {
    now,
    replyClient: scriptedWriter('unused'),
    composeNight: async () => 'A model-written duty question.',
  });

const splitSweep = (now: Date) =>
  sweepDutyAsks(db.database, { now, replyClient: scriptedWriter(SPLIT_TEXT) });

async function dutyRows(familyId: string) {
  return db.database
    .select({
      dedupeKey: schema.channelMessages.dedupeKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      parentUserId: schema.channelMessages.parentUserId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.category, 'duty_ask'),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
}

describe('with the flag on, two families on one calendar event', () => {
  beforeEach(() => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
  });

  it('texts each family its own night-before duty line', async () => {
    const wire = linqWire([HOUSE_A, HOUSE_B]);
    const first = await nightBeforeHousehold(HOUSE_A);
    const second = await nightBeforeHousehold(HOUSE_B);

    await nightSweep(EVENING);

    expect(wire.bubblesTo(HOUSE_A.chatId as string)).toBe(1);
    expect(wire.bubblesTo(HOUSE_B.chatId as string)).toBe(1);
    const [firstRow] = await dutyRows(first.familyId);
    const [secondRow] = await dutyRows(second.familyId);
    expect(firstRow?.dedupeKey?.startsWith(`duty_ask:${first.familyId}:`)).toBe(true);
    expect(secondRow?.dedupeKey?.startsWith(`duty_ask:${second.familyId}:`)).toBe(true);
    expect(firstRow?.status).toBe('sent');
    expect(secondRow?.status).toBe('sent');

    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));
    expect(wire.posts).toHaveLength(2);
  });

  it('texts each family its own split ask in its group', async () => {
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const wire = linqWire([HOUSE_A, HOUSE_B]);
    const first = await splitHousehold(HOUSE_A);
    const second = await splitHousehold(HOUSE_B);

    await splitSweep(AFTERNOON);

    expect(wire.bubblesTo(HOUSE_A.chatId as string)).toBe(1);
    expect(wire.bubblesTo(HOUSE_B.chatId as string)).toBe(1);
    for (const family of [first, second]) {
      const rows = await dutyRows(family.familyId);
      expect(rows.map((row) => row.status)).toEqual(['sent']);
      expect(rows[0]?.dedupeKey?.startsWith(`duty_ask:${family.familyId}:split_duty:`)).toBe(true);
    }
  });

  it('texts both parents in each family a split ask on their own 1:1', async () => {
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const wire = linqWire([DIRECT_A, DIRECT_B]);
    const first = await splitHousehold(DIRECT_A);
    const second = await splitHousehold(DIRECT_B);

    await splitSweep(AFTERNOON);

    for (const phone of [...DIRECT_A.phones, ...DIRECT_B.phones]) {
      expect(wire.bubblesTo(phone)).toBe(1);
    }
    for (const family of [first, second]) {
      const rows = await dutyRows(family.familyId);
      expect(rows.map((row) => row.status)).toEqual(['sent', 'sent']);
      expect(
        rows.every((row) => row.dedupeKey?.startsWith(`duty_ask:${family.familyId}:split_duty:`)),
      ).toBe(true);
    }

    await splitSweep(new Date(AFTERNOON.getTime() + HOUR_MS));
    expect(wire.posts).toHaveLength(4);
  });
});

describe('sends already made under the old key, when the flag goes on', () => {
  it("does not repeat this family's sent text, and another family's old row does not count", async () => {
    const wire = linqWire([HOUSE_A, HOUSE_B]);
    const first = await nightBeforeHousehold(HOUSE_A);
    await nightSweep(EVENING);
    const [oldRow] = await dutyRows(first.familyId);
    expect(oldRow?.status).toBe('sent');
    expect(oldRow?.dedupeKey?.startsWith('duty_ask:night_before:')).toBe(true);

    await nightBeforeHousehold(HOUSE_B);
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));

    expect(wire.bubblesTo(HOUSE_A.chatId as string)).toBe(1);
    expect(wire.bubblesTo(HOUSE_B.chatId as string)).toBe(1);
    expect(await dutyRows(first.familyId)).toHaveLength(1);
  });

  it('retries a may-have-landed group try under its original Linq key', async () => {
    const wire = linqWire([HOUSE_A]);
    const family = await nightBeforeHousehold(HOUSE_A);
    wire.failNextPosts(1);
    await nightSweep(EVENING);
    const [tried] = await dutyRows(family.familyId);
    expect(tried?.errorCode?.startsWith('unconfirmed:')).toBe(true);
    const oldKey = tried?.dedupeKey as string;
    expect(oldKey.startsWith('duty_ask:night_before:')).toBe(true);

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));

    expect(wire.posts.map((post) => post.key)).toEqual([linqKey(oldKey), linqKey(oldKey)]);
    expect(wire.bubblesTo(HOUSE_A.chatId as string)).toBe(1);
    const rows = await dutyRows(family.familyId);
    expect(rows.map((row) => row.status)).toEqual(['failed', 'sent']);
    expect(rows[1]?.dedupeKey).toBe(
      `duty_ask:${family.familyId}:${oldKey.slice('duty_ask:'.length)}:retry:1`,
    );
  });

  it("retries a may-have-landed split leg under that parent's original Linq key", async () => {
    vi.stubEnv(COPARENT_SPLIT_DUTY_ENABLED_ENV, 'true');
    const wire = linqWire([DIRECT_A]);
    const family = await splitHousehold(DIRECT_A);
    wire.failNextPosts(1);
    await splitSweep(AFTERNOON);
    const before = await dutyRows(family.familyId);
    const failedLeg = before.find((row) => row.status === 'failed');
    expect(failedLeg?.errorCode?.startsWith('unconfirmed:')).toBe(true);
    const oldLegKey = failedLeg?.dedupeKey as string;

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await splitSweep(new Date(AFTERNOON.getTime() + HOUR_MS));

    const retried = wire.posts.at(-1);
    expect(retried?.key).toBe(linqKey(oldLegKey));
    expect(wire.posts).toHaveLength(3);
    for (const phone of DIRECT_A.phones) expect(wire.bubblesTo(phone)).toBe(1);
  });
});

describe('one send with rows under both key shapes', () => {
  const dropped = (familyId: string) =>
    db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'duty_send_dropped'),
        ),
      );

  it('is not settled as stranded once the retry under the new key was accepted', async () => {
    const wire = linqWire([HOUSE_A]);
    const family = await nightBeforeHousehold(HOUSE_A);
    wire.failNextPosts(1);
    await nightSweep(EVENING);

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    for (const hours of [1, 2, 3, 4]) {
      await nightSweep(new Date(EVENING.getTime() + hours * HOUR_MS));
    }

    expect(await dropped(family.familyId)).toEqual([]);
    const rows = await dutyRows(family.familyId);
    expect(rows.map((row) => row.errorCode)).toEqual(['unconfirmed:500', null]);
    expect(wire.posts).toHaveLength(2);
  });

  const noPage = {
    page: async () => {
      throw new Error('a settled send must not page');
    },
  };

  async function outRow(
    family: Seeded,
    dedupeKey: string,
    parentUserId: string,
    state: { status: 'failed' | 'sent'; errorCode: string | null; createdAt: Date },
  ) {
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      dedupeKey,
      ...state,
    });
  }

  it('reads a retry the sweep still offers under the new key as the same send', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    const family = await seedHousehold(HOUSE_A, EVENING);
    const rest = `night_before:${SHARED_EVENT}:pickup:2026-09-27`;
    await outRow(family, `duty_ask:${rest}`, family.parentUserId, {
      status: 'failed',
      errorCode: 'http_400',
      createdAt: new Date(EVENING.getTime() - 3 * HOUR_MS),
    });

    await settleStrandedDutySends(db.database, {
      now: EVENING,
      pager: noPage,
      offered: new Set([dutySendScope(family.familyId, `duty_ask:${family.familyId}:${rest}`)]),
      readOpenQuestion: async () => null,
    });

    expect(await dropped(family.familyId)).toEqual([]);
  });

  it('settles a leg under the new key without a page once the other parent answered', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    const family = await seedHousehold(DIRECT_A, EVENING);
    const askKey = `duty_ask:${family.familyId}:split_duty:evt-a:attend:2026-09-27`;
    const askedAt = new Date(EVENING.getTime() - 3 * HOUR_MS);
    await outRow(family, `${askKey}:${family.parentUserId}`, family.parentUserId, {
      status: 'sent',
      errorCode: null,
      createdAt: askedAt,
    });
    await outRow(family, `${askKey}:${family.secondUserId}`, family.secondUserId, {
      status: 'failed',
      errorCode: 'http_400',
      createdAt: askedAt,
    });
    const answered: OpenDutyFact = {
      open: {
        eventKey: 'evt-a',
        role: 'attend',
        unanswered: 1,
        silentNamed: false,
        status: 'stepped_down',
        split: true,
        peerEventKey: 'evt-b',
      },
      validFrom: new Date(askedAt.getTime() + HOUR_MS),
    };

    await settleStrandedDutySends(db.database, {
      now: EVENING,
      pager: noPage,
      offered: new Set(),
      readOpenQuestion: async () => answered,
    });

    const audits = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, family.familyId),
          eq(schema.auditLog.actionTaken, 'duty_send_dropped'),
        ),
      );
    expect(audits.map((row) => (row.after as { reason: string }).reason)).toEqual(['answered']);
  });

  it('still honours a decline recorded against the old ask key', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const wire = linqWire([HOUSE_A]);
    const family = await nightBeforeHousehold(HOUSE_A);
    wire.failNextPosts(1);
    await nightSweep(EVENING);
    const [tried] = await dutyRows(family.familyId);
    await db.database.insert(schema.optionalAskLedger).values({
      familyId: family.familyId,
      sendClass: 'duty_ask',
      askKey: tried?.dedupeKey as string,
      outcome: 'declined',
      localDay: '2026-09-27',
    });

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));

    expect(wire.posts).toHaveLength(1);
  });

  it('is dropped once, with one row marked, when nothing offers it again', async () => {
    const wire = linqWire([HOUSE_A]);
    const family = await nightBeforeHousehold(HOUSE_A);
    wire.failNextPosts(2);
    await nightSweep(EVENING);
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));
    expect(await dutyRows(family.familyId)).toHaveLength(2);

    // The plan stops offering a night-before ask after its event has started.
    await sweepDutyAsks(db.database, {
      now: new Date(MONDAY.getTime() + 2 * HOUR_MS),
      replyClient: scriptedWriter('unused'),
      composeNight: async () => 'A model-written duty question.',
    });

    expect(await dropped(family.familyId)).toHaveLength(1);
    const rows = await dutyRows(family.familyId);
    expect(rows.filter((row) => row.errorCode === 'send_retries_exhausted')).toHaveLength(1);
  });
});

describe('with the decider live', () => {
  const candidates = (familyId: string) =>
    db.database
      .select({ dedupeKey: schema.proactiveCandidates.dedupeKey })
      .from(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, familyId));

  it('holds a candidate queued under the old key, and queues the other family its own', async () => {
    vi.stubEnv(PROACTIVE_CADENCE_ENV, 'live');
    const wire = linqWire([HOUSE_A, HOUSE_B]);
    const first = await nightBeforeHousehold(HOUSE_A);
    await nightSweep(EVENING);
    const [held] = await candidates(first.familyId);
    expect(held?.dedupeKey.startsWith('duty_ask:night_before:')).toBe(true);

    const second = await nightBeforeHousehold(HOUSE_B);
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await nightSweep(new Date(EVENING.getTime() + HOUR_MS));

    expect(await candidates(first.familyId)).toHaveLength(1);
    const [own] = await candidates(second.familyId);
    expect(own?.dedupeKey.startsWith(`duty_ask:${second.familyId}:`)).toBe(true);
    expect(wire.posts).toEqual([]);
  });
});

describe('with the flag off', () => {
  it('keeps the old key, and the second family still loses its text as on main', async () => {
    const wire = linqWire([HOUSE_A, HOUSE_B]);
    const first = await nightBeforeHousehold(HOUSE_A);
    const second = await nightBeforeHousehold(HOUSE_B);

    await nightSweep(EVENING);

    const delivered = [
      wire.bubblesTo(HOUSE_A.chatId as string),
      wire.bubblesTo(HOUSE_B.chatId as string),
    ].sort();
    expect(delivered).toEqual([0, 1]);
    const rows = [...(await dutyRows(first.familyId)), ...(await dutyRows(second.familyId))];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toMatch(
      new RegExp(`^duty_ask:night_before:${SHARED_EVENT}:[a-z_]+:2026-09-27$`),
    );
  });
});
