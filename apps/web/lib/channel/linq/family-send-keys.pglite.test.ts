import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_SCOPED_SEND_KEYS_ENV } from '~/lib/channel/family-send-key';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type ProactiveReviewDeps, runProactiveReview } from '~/lib/channel/proactive/review';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type OneToOneSend, noticeIfGroupQuiet } from './connect-link-1to1';
import { setGroupConflictWriter } from './group-conflict-voice';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { narrateHouseholdCalendar, rememberAndNarrateCalendar } from './household-calendar';

/**
 * Two households holding one calendar event id, on the real ledger. The dedupe index is
 * global, so a key with no family in it lets the first family's send use up the second's.
 * The writer of the clash line is a fake here; its wording is graded by the clash eval.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** 14:00 America/Toronto. */
const DAY = new Date('2026-09-25T18:00:00.000Z');
/** 17:30 America/Toronto the evening before DAY's events. */
const HANDOFF_AT = new Date('2026-09-24T21:30:00.000Z');
const AT_3 = new Date('2026-09-25T19:00:00.000Z');
const AT_330 = new Date('2026-09-25T19:30:00.000Z');
const AT_4 = new Date('2026-09-25T20:00:00.000Z');

interface Household {
  chatId: string;
  phones: readonly [string, string];
}

const HOUSEHOLD_A: Household = {
  chatId: 'chat-family-a',
  phones: ['+14165550111', '+19055550182'],
};
const HOUSEHOLD_B: Household = {
  chatId: 'chat-family-b',
  phones: ['+14165550121', '+19055550192'],
};

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
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.stubEnv('CROSS_PARENT_CLASH_ENABLED', 'false');
  vi.stubEnv('LINQ_GROUP_CONFLICT_ALERTS_ENABLED', 'false');
  vi.stubEnv('LINQ_POLLS', 'off');
  setGroupConflictWriter({
    async write() {
      return { text: 'FAKE clash line', figureItOut: null };
    },
  });
});

afterEach(async () => {
  setGroupConflictWriter(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, linq_group_rosters cascade');
});

interface Wire {
  fetch: typeof fetch;
  texts(chatId: string): number;
  pollKeys(chatId: string): string[];
}

function householdWire(over: { refusePolls?: boolean } = {}): Wire {
  const texts: string[] = [];
  const polls: Array<{ chatId: string; key: string }> = [];
  const households = [HOUSEHOLD_A, HOUSEHOLD_B];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const household = households.find((row) => target.includes(`/chats/${row.chatId}`));
    if (!household) throw new Error(`unexpected wire call: ${target}`);
    if (init?.method === 'GET') {
      return Response.json({
        chat: {
          id: household.chatId,
          is_group: true,
          handles: household.phones.map((handle) => ({ handle })),
        },
      });
    }
    if (target.endsWith('/polls')) {
      const body = JSON.parse(String(init?.body)) as {
        idempotency_key?: string;
        poll?: { idempotency_key?: string; options?: { text: string }[] };
      };
      polls.push({
        chatId: household.chatId,
        key: String(body.idempotency_key ?? body.poll?.idempotency_key),
      });
      if (over.refusePolls) {
        return new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          message_id: `poll-${polls.length}`,
          poll: {
            options: (body.poll?.options ?? []).map((option, index) => ({
              option_id: `opt-${polls.length}-${index}`,
              text: option.text,
            })),
          },
        }),
        { status: 202 },
      );
    }
    texts.push(household.chatId);
    return Response.json({ message: { id: `m-${texts.length}` } });
  });
  vi.stubGlobal('fetch', fetchImpl);
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: (chatId) => texts.filter((sent) => sent === chatId).length,
    pollKeys: (chatId) => polls.filter((poll) => poll.chatId === chatId).map((poll) => poll.key),
  };
}

interface Seeded extends Household {
  familyId: string;
  primaryUserId: string;
  coparentUserId: string;
  primaryIntegrationId: string;
  coparentIntegrationId: string;
}

async function seedHousehold(household: Household): Promise<Seeded> {
  const [primaryPhone, coparentPhone] = household.phones;
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
  const [primary] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:primary-${familyId}`,
      name: 'Riley',
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const [coparent] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:coparent-${familyId}`,
      name: 'Sam',
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const primaryUserId = primary?.id as string;
  const coparentUserId = coparent?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primaryUserId, role: 'primary_parent' },
    { familyId, userId: coparentUserId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values(
    [
      { userId: primaryUserId, phone: primaryPhone },
      { userId: coparentUserId, phone: coparentPhone },
    ].map(({ userId, phone }) => ({
      userId,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: DAY,
    })),
  );
  await db.database.insert(schema.consentRecords).values([
    {
      userId: primaryUserId,
      familyId,
      consentType: 'proactive_watch',
      granted: true,
      consentScope: WATCH_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'yes please' },
    },
    {
      userId: coparentUserId,
      familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_coparent_invite_reply',
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'hi there' },
    },
  ]);
  await db.database.insert(schema.children).values([
    { familyId, name: 'Maya', dateOfBirth: '2022-04-01' },
    { familyId, name: 'Leo', dateOfBirth: '2023-06-01' },
  ]);
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
      phoneE164Hash: phoneBlindIndex(primaryPhone),
      knownUserId: primaryUserId,
      status: 'known_parent',
    },
    {
      rosterId: roster?.id as string,
      chatId: household.chatId,
      phoneE164Hash: phoneBlindIndex(coparentPhone),
      userId: coparentUserId,
      status: 'confirmed',
      confirmedRole: 'co_parent',
    },
  ]);
  const calendars = await db.database
    .insert(schema.integrations)
    .values(
      [primaryUserId, coparentUserId].map((userId) => ({
        familyId,
        userId,
        provider: 'gcal' as const,
        status: 'active' as const,
        oauthTokensEncrypted: `opaque-${userId}`,
      })),
    )
    .returning({ id: schema.integrations.id, userId: schema.integrations.userId });
  return {
    ...household,
    familyId,
    primaryUserId,
    coparentUserId,
    primaryIntegrationId: calendars.find((row) => row.userId === primaryUserId)?.id as string,
    coparentIntegrationId: calendars.find((row) => row.userId === coparentUserId)?.id as string,
  };
}

async function calendarBlock(
  seeded: Seeded,
  who: 'primary' | 'coparent',
  item: {
    eventId: string;
    title: string | null;
    start: Date;
    end: Date;
    announcedAt?: Date;
  },
): Promise<void> {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId: who === 'primary' ? seeded.primaryIntegrationId : seeded.coparentIntegrationId,
    userId: who === 'primary' ? seeded.primaryUserId : seeded.coparentUserId,
    familyId: seeded.familyId,
    eventId: item.eventId,
    startAt: item.start,
    endAt: item.end,
    kidRelated: item.title !== null,
    title: item.title,
    calendarStanding: item.title === null ? undefined : 'organizer',
    status: 'confirmed',
    updatedStamp: `stamp-${item.eventId}`,
    announcedAt: item.announcedAt ?? null,
  });
}

interface Lane {
  name: 'kids' | 'conflict' | 'handoff' | 'followup' | 'who-takes' | 'clash';
  now: Date;
  /** The key after `linq-group:`. Null for clash, whose tail is a hash of its two plans. */
  tail: string | null;
  template: string;
  env?: Readonly<Record<string, string>>;
  refusePolls?: boolean;
  seed(seeded: Seeded): Promise<void>;
}

const MAYA_GYM = 'Maya gymnastics';

const LANES: readonly Lane[] = [
  {
    name: 'kids',
    now: DAY,
    tail: 'kids:evt-1',
    template: 'linq:group_kid_event',
    seed: (seeded) =>
      calendarBlock(seeded, 'primary', {
        eventId: 'evt-1',
        title: MAYA_GYM,
        start: new Date('2026-09-26T19:00:00.000Z'),
        end: new Date('2026-09-26T20:00:00.000Z'),
      }),
  },
  {
    name: 'conflict',
    now: DAY,
    tail: `conflict:evt-1:${AT_3.toISOString()}`,
    template: 'linq:group_conflict',
    seed: async (seeded) => {
      await calendarBlock(seeded, 'primary', {
        eventId: 'evt-1',
        title: MAYA_GYM,
        start: AT_3,
        end: AT_4,
      });
      await calendarBlock(seeded, 'coparent', {
        eventId: 'busy-1',
        title: null,
        start: AT_3,
        end: AT_4,
      });
    },
  },
  {
    name: 'handoff',
    now: HANDOFF_AT,
    tail: `handoff:evt-1:${AT_3.toISOString()}`,
    template: 'linq:group_handoff',
    seed: (seeded) =>
      calendarBlock(seeded, 'primary', {
        eventId: 'evt-1',
        title: MAYA_GYM,
        start: AT_3,
        end: AT_4,
      }),
  },
  {
    name: 'followup',
    now: DAY,
    tail: 'followup:evt-1',
    template: 'linq:group_followup',
    seed: (seeded) =>
      calendarBlock(seeded, 'primary', {
        eventId: 'evt-1',
        title: MAYA_GYM,
        start: new Date(DAY.getTime() - 2 * 3_600_000),
        end: new Date(DAY.getTime() - 3_600_000),
        announcedAt: new Date(DAY.getTime() - 3 * 3_600_000),
      }),
  },
  {
    name: 'who-takes',
    now: HANDOFF_AT,
    tail: `who-takes:evt-1:${AT_3.toISOString()}`,
    template: 'linq:group_who_takes',
    env: { LINQ_POLLS: 'on' },
    refusePolls: true,
    seed: (seeded) =>
      calendarBlock(seeded, 'primary', {
        eventId: 'evt-1',
        title: MAYA_GYM,
        start: AT_3,
        end: AT_3,
      }),
  },
  {
    name: 'clash',
    now: DAY,
    tail: null,
    template: 'linq:group_clash',
    env: { LINQ_GROUP_CONFLICT_ALERTS_ENABLED: 'true' },
    seed: async (seeded) => {
      await calendarBlock(seeded, 'primary', {
        eventId: 'swim',
        title: 'Maya swim pickup',
        start: AT_3,
        end: AT_330,
      });
      await calendarBlock(seeded, 'primary', {
        eventId: 'daycare',
        title: 'Leo daycare pickup',
        start: AT_3,
        end: AT_330,
      });
    },
  },
];

const KEY_ONLY_LANES = LANES.filter((lane) =>
  ['conflict', 'handoff', 'who-takes', 'clash'].includes(lane.name),
);

function armLane(lane: Lane): void {
  for (const [name, value] of Object.entries(lane.env ?? {})) vi.stubEnv(name, value);
}

async function ledger(familyId: string) {
  return db.database
    .select({
      dedupeKey: schema.channelMessages.dedupeKey,
      templateKey: schema.channelMessages.templateKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

function expectKey(key: string | null, lane: Lane, familyId: string | null): void {
  const head = familyId === null ? 'linq-group:' : `linq-group:${familyId}:`;
  if (lane.tail === null) expect(key).toMatch(new RegExp(`^${head}clash:[0-9a-f]{32}$`));
  else expect(key).toBe(`${head}${lane.tail}`);
}

describe('two families on one calendar event, flag on', () => {
  it.each(LANES)('$name: each family gets its own text under its own key', async (lane) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    armLane(lane);
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await lane.seed(a);
    await lane.seed(b);
    const wire = householdWire({ refusePolls: lane.refusePolls });

    await narrateHouseholdCalendar(db.database, {
      familyId: a.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
    await narrateHouseholdCalendar(db.database, {
      familyId: b.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });

    expect(wire.texts(a.chatId)).toBe(1);
    expect(wire.texts(b.chatId)).toBe(1);
    const [rowA, ...moreA] = await ledger(a.familyId);
    const [rowB, ...moreB] = await ledger(b.familyId);
    expect(moreA).toEqual([]);
    expect(moreB).toEqual([]);
    expect(rowA?.templateKey).toBe(lane.template);
    expect(rowB?.templateKey).toBe(lane.template);
    expectKey(rowA?.dedupeKey ?? null, lane, a.familyId);
    expectKey(rowB?.dedupeKey ?? null, lane, b.familyId);
    expect(rowA?.dedupeKey?.split(':').at(-1)).toBe(rowB?.dedupeKey?.split(':').at(-1));
  });
});

describe('two families on one calendar event, flag off', () => {
  it.each(LANES)('$name: the old global key, exactly as before', async (lane) => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    armLane(lane);
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await lane.seed(a);
    await lane.seed(b);
    const wire = householdWire({ refusePolls: lane.refusePolls });

    await narrateHouseholdCalendar(db.database, {
      familyId: a.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
    await narrateHouseholdCalendar(db.database, {
      familyId: b.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });

    expect(wire.texts(a.chatId)).toBe(1);
    const [rowA, ...moreA] = await ledger(a.familyId);
    expect(moreA).toEqual([]);
    expect(rowA?.templateKey).toBe(lane.template);
    expectKey(rowA?.dedupeKey ?? null, lane, null);
    const rowsB = await ledger(b.familyId);
    if (lane.name === 'clash') {
      // The spent clash falls through to the kid-event planner, so this family hears about
      // the two events but is never told they clash.
      expect(wire.texts(b.chatId)).toBe(1);
      expect(rowsB).toEqual([
        { dedupeKey: 'linq-group:kids:swim:daycare', templateKey: 'linq:group_kid_event' },
      ]);
    } else {
      expect(wire.texts(b.chatId)).toBe(0);
      expect(rowsB).toEqual([]);
    }
  });
});

describe('turning the flag on after sends under the old key', () => {
  it.each(KEY_ONLY_LANES)(
    '$name: a family already told under the old key is not told again',
    async (lane) => {
      armLane(lane);
      const a = await seedHousehold(HOUSEHOLD_A);
      await lane.seed(a);
      const wire = householdWire({ refusePolls: lane.refusePolls });

      vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
      await narrateHouseholdCalendar(db.database, {
        familyId: a.familyId,
        now: lane.now,
        fetch: wire.fetch,
      });
      expect(wire.texts(a.chatId)).toBe(1);

      vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
      await narrateHouseholdCalendar(db.database, {
        familyId: a.familyId,
        now: lane.now,
        fetch: wire.fetch,
      });

      expect(wire.texts(a.chatId)).toBe(1);
      const rows = await ledger(a.familyId);
      expect(rows).toHaveLength(1);
      expectKey(rows[0]?.dedupeKey ?? null, lane, null);
    },
  );

  it.each(LANES)("$name: another family's old-key row does not block this family", async (lane) => {
    armLane(lane);
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await lane.seed(a);
    await lane.seed(b);
    const wire = householdWire({ refusePolls: lane.refusePolls });

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    await narrateHouseholdCalendar(db.database, {
      familyId: a.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
    expect(wire.texts(a.chatId)).toBe(1);

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    await narrateHouseholdCalendar(db.database, {
      familyId: b.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
    expect(wire.texts(b.chatId)).toBe(1);
    const rowsB = await ledger(b.familyId);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.templateKey).toBe(lane.template);
    expectKey(rowsB[0]?.dedupeKey ?? null, lane, b.familyId);

    await narrateHouseholdCalendar(db.database, {
      familyId: b.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
    expect(wire.texts(b.chatId)).toBe(1);
    expect(await ledger(b.familyId)).toHaveLength(1);
  });
});

const CONFLICT_LANE = LANES.find((lane) => lane.name === 'conflict') as Lane;
const KIDS_LANE = LANES.find((lane) => lane.name === 'kids') as Lane;

async function queuedUnderOldKey(
  seeded: Seeded,
  lane: Lane,
  over: {
    status: 'queued' | 'held' | 'dropped' | 'sent';
    reason?: string | null;
    dedupeKey?: string;
  },
): Promise<void> {
  await db.database.insert(schema.proactiveCandidates).values({
    familyId: seeded.familyId,
    parentUserId: seeded.primaryUserId,
    kind: 'activity_followup',
    category: 'calendar_alert',
    templateKey: lane.template,
    what: 'FAKE old queued line',
    why: 'activity_followup',
    dedupeKey: over.dedupeKey ?? `linq-group:${lane.tail}`,
    status: over.status,
    reason: over.reason ?? null,
  });
}

async function sentUnderOldKey(owner: Seeded, lane: Lane): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: owner.familyId,
    parentUserId: owner.primaryUserId,
    channel: 'imessage',
    direction: 'out',
    category: 'calendar_alert',
    templateKey: lane.template,
    dedupeKey: `linq-group:${lane.tail}`,
    providerChatId: owner.chatId,
    status: 'sent',
    sentAt: new Date(lane.now.getTime() - 3_600_000),
  });
}

async function candidateKeys(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ dedupeKey: schema.proactiveCandidates.dedupeKey })
    .from(schema.proactiveCandidates)
    .where(and(eq(schema.proactiveCandidates.familyId, familyId)));
  return rows.map((row) => row.dedupeKey).sort();
}

describe('the sweep with a text in the decider queue under the old key (live)', () => {
  beforeEach(() => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
  });

  async function narrate(seeded: Seeded, lane: Lane, wire: Wire): Promise<void> {
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });
  }

  it('a queued candidate holds: no second candidate, no text', async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await CONFLICT_LANE.seed(a);
    await queuedUnderOldKey(a, CONFLICT_LANE, { status: 'queued' });
    const wire = householdWire();
    await narrate(a, CONFLICT_LANE, wire);
    expect(await candidateKeys(a.familyId)).toEqual([`linq-group:${CONFLICT_LANE.tail}`]);
    expect(wire.texts(a.chatId)).toBe(0);
  });

  it("the decider's own drop holds, even though its reason is null", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await CONFLICT_LANE.seed(a);
    await queuedUnderOldKey(a, CONFLICT_LANE, { status: 'dropped', reason: null });
    const wire = householdWire();
    await narrate(a, CONFLICT_LANE, wire);
    expect(await candidateKeys(a.familyId)).toEqual([`linq-group:${CONFLICT_LANE.tail}`]);
    expect(wire.texts(a.chatId)).toBe(0);
  });

  it("an already_sent drop caused by another family's row is queued again under this family's key", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await CONFLICT_LANE.seed(a);
    await queuedUnderOldKey(a, CONFLICT_LANE, { status: 'dropped', reason: 'already_sent' });
    await sentUnderOldKey(b, CONFLICT_LANE);
    const wire = householdWire();
    await narrate(a, CONFLICT_LANE, wire);
    expect(await candidateKeys(a.familyId)).toEqual(
      [`linq-group:${CONFLICT_LANE.tail}`, `linq-group:${a.familyId}:${CONFLICT_LANE.tail}`].sort(),
    );
    expect(wire.texts(a.chatId)).toBe(0);
  });

  it("an already_sent drop that was this family's own send stays settled", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await CONFLICT_LANE.seed(a);
    await queuedUnderOldKey(a, CONFLICT_LANE, { status: 'dropped', reason: 'already_sent' });
    await sentUnderOldKey(a, CONFLICT_LANE);
    const wire = householdWire();
    await narrate(a, CONFLICT_LANE, wire);
    expect(await candidateKeys(a.familyId)).toEqual([`linq-group:${CONFLICT_LANE.tail}`]);
    expect(wire.texts(a.chatId)).toBe(0);
  });

  it('a kid-event line the decider sent, with no stamp on the block, is not queued again', async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await KIDS_LANE.seed(a);
    await queuedUnderOldKey(a, KIDS_LANE, { status: 'sent' });
    await sentUnderOldKey(a, KIDS_LANE);
    const wire = householdWire();
    await narrate(a, KIDS_LANE, wire);
    expect(await candidateKeys(a.familyId)).toEqual([`linq-group:${KIDS_LANE.tail}`]);
    expect(wire.texts(a.chatId)).toBe(0);
  });
});

function deciderHarness(): { deps: ProactiveReviewDeps; transport: FakeTransport } {
  const transport = new FakeTransport();
  const openGate = (): OutboundGatePorts => ({
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => 'America/Toronto',
  });
  const deps: ProactiveReviewDeps = {
    client: null,
    transport,
    decide: async ({ snapshot }) => ({
      decision: {
        reason: 'it fits this afternoon',
        action: 'send_now',
        itemIds: snapshot.candidates.map((candidate) => candidate.id),
        holdUntil: null,
        frequencyPreference: null,
      },
      skipped: null,
    }),
    compose: async () => ({ message: 'FAKE decider line' }),
    buildGate: openGate,
    resolveSendablePhone: async () => HOUSEHOLD_A.phones[0],
    lineHold: async () => null,
    loadRecipients: async () => [],
    outboundTarget: async () => ({ channel: 'legacy' }),
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    recheckOpenAsk: async () => ({ verdict: 'owed', timeZone: 'America/Toronto' }),
    page: async () => 'paged',
  };
  return { deps, transport };
}

async function candidateStates(familyId: string) {
  const rows = await db.database
    .select({
      dedupeKey: schema.proactiveCandidates.dedupeKey,
      status: schema.proactiveCandidates.status,
      reason: schema.proactiveCandidates.reason,
    })
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
  return rows.sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey));
}

async function ledgerKeys(familyId: string): Promise<Array<string | null>> {
  return (await ledger(familyId)).map((row) => row.dedupeKey);
}

describe('the decider with a candidate under either key shape', () => {
  const lane = CONFLICT_LANE;
  const oldKey = `linq-group:${lane.tail}`;
  const newKey = (seeded: Seeded) => `linq-group:${seeded.familyId}:${lane.tail}`;

  beforeEach(() => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
  });

  it.each(['off', 'shadow'])(
    'a text the %s sweep sent under the new key is not sent again for its old-key candidate',
    async (sweepCadence) => {
      const a = await seedHousehold(HOUSEHOLD_A);
      await lane.seed(a);
      await queuedUnderOldKey(a, lane, { status: 'queued' });
      const wire = householdWire();
      vi.stubEnv('PROACTIVE_CADENCE', sweepCadence);
      await narrateHouseholdCalendar(db.database, {
        familyId: a.familyId,
        now: lane.now,
        fetch: wire.fetch,
      });
      expect(wire.texts(a.chatId)).toBe(1);
      expect(await ledgerKeys(a.familyId)).toEqual([newKey(a)]);

      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const { deps, transport } = deciderHarness();
      await runProactiveReview(db.database, deps, lane.now);

      expect(transport.sent).toEqual([]);
      expect(await ledgerKeys(a.familyId)).toEqual([newKey(a)]);
      const states = await candidateStates(a.familyId);
      expect(states.find((row) => row.dedupeKey === oldKey)).toMatchObject({
        status: 'dropped',
        reason: 'already_sent',
      });
      expect(states.filter((row) => row.status === 'queued')).toEqual([]);
    },
  );

  it('two families holding one old key each get one text under their own key', async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    await queuedUnderOldKey(b, lane, { status: 'queued' });
    const { deps, transport } = deciderHarness();

    const summary = await runProactiveReview(db.database, deps, lane.now);

    expect(summary.failed).toBe(0);
    expect(transport.sent).toHaveLength(2);
    expect(await ledgerKeys(a.familyId)).toEqual([newKey(a)]);
    expect(await ledgerKeys(b.familyId)).toEqual([newKey(b)]);
  });

  it("another family's row under the old key does not stop this family's candidate", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await sentUnderOldKey(b, lane);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toHaveLength(1);
    expect(await ledgerKeys(a.familyId)).toEqual([newKey(a)]);
  });

  it("this family's own row under the old key stops its candidate", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await sentUnderOldKey(a, lane);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toEqual([]);
    expect(await candidateStates(a.familyId)).toEqual([
      { dedupeKey: oldKey, status: 'dropped', reason: 'already_sent' },
    ]);
  });

  it('old-key and new-key candidates for one text send once, under the new key', async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    await queuedUnderOldKey(a, lane, { status: 'queued', dedupeKey: newKey(a) });
    const { deps, transport } = deciderHarness();

    const summary = await runProactiveReview(db.database, deps, lane.now);

    expect(summary.failed).toBe(0);
    expect(transport.sent).toHaveLength(1);
    expect(await ledgerKeys(a.familyId)).toEqual([newKey(a)]);
  });

  it("a new-key candidate is stopped by this family's row under the old key", async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    await sentUnderOldKey(a, lane);
    await queuedUnderOldKey(a, lane, { status: 'queued', dedupeKey: newKey(a) });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toEqual([]);
    expect(await ledgerKeys(a.familyId)).toEqual([oldKey]);
  });

  it('a cross-parent 1:1 clash candidate keeps its exact key', async () => {
    const a = await seedHousehold(HOUSEHOLD_A);
    const crossParentKey = `linq-group:clash:${'a'.repeat(32)}:1to1:${a.primaryUserId}`;
    await queuedUnderOldKey(a, lane, { status: 'queued', dedupeKey: crossParentKey });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toHaveLength(1);
    expect(await ledgerKeys(a.familyId)).toEqual([crossParentKey]);
  });

  it('with the flag off, an old-key candidate sends under the old key', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    const a = await seedHousehold(HOUSEHOLD_A);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toHaveLength(1);
    expect(await ledgerKeys(a.familyId)).toEqual([oldKey]);
  });

  it("with the flag off, another family's row still drops the candidate, as before", async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await sentUnderOldKey(b, lane);
    await queuedUnderOldKey(a, lane, { status: 'queued' });
    const { deps, transport } = deciderHarness();

    await runProactiveReview(db.database, deps, lane.now);

    expect(transport.sent).toEqual([]);
    expect(await ledgerKeys(a.familyId)).toEqual([]);
    expect(await candidateStates(a.familyId)).toEqual([
      { dedupeKey: oldKey, status: 'dropped', reason: 'already_sent' },
    ]);
  });
});

describe('the group quiet notice', () => {
  const QUIET_CHAT = 'chat-went-quiet';
  const OLD_QUIET_KEY = `linq:group_quiet_notice:${QUIET_CHAT}`;

  async function quietRoster(owner: Seeded): Promise<string> {
    const [roster] = await db.database
      .insert(schema.linqGroupRosters)
      .values({
        chatId: QUIET_CHAT,
        familyId: owner.familyId,
        source: 'added_to_existing',
        status: 'confirmed',
      })
      .returning({ id: schema.linqGroupRosters.id });
    const rosterId = roster?.id as string;
    await db.database.insert(schema.linqGroupRosterMembers).values([
      {
        rosterId,
        chatId: QUIET_CHAT,
        phoneE164Hash: phoneBlindIndex(owner.phones[0]),
        knownUserId: owner.primaryUserId,
        status: 'known_parent',
      },
      {
        rosterId,
        chatId: QUIET_CHAT,
        phoneE164Hash: phoneBlindIndex('+14165550199'),
        status: 'not_family',
      },
    ]);
    return rosterId;
  }

  function oneToOne(): { send: OneToOneSend; to: string[] } {
    const to: string[] = [];
    return {
      to,
      send: {
        text: async (input) => {
          to.push(input.to);
          return { providerMessageId: `fake-1to1-${to.length}`, chatId: 'chat-one-to-one' };
        },
        link: async () => ({ providerMessageId: 'fake-link' }),
      },
    };
  }

  it('goes to each family once, and an old row counts only for the family it reached', async () => {
    const one = await seedHousehold(HOUSEHOLD_A);
    const two = await seedHousehold(HOUSEHOLD_B);
    const rosterId = await quietRoster(one);
    const sends = oneToOne();
    const notice = () =>
      noticeIfGroupQuiet(db.database, {
        chatId: QUIET_CHAT,
        now: DAY,
        voice: fakeGroupOnboardingComposer(),
        oneToOne: sends.send,
      });
    const pointRosterAt = (seeded: Seeded) =>
      db.database
        .update(schema.linqGroupRosters)
        .set({ familyId: seeded.familyId })
        .where(eq(schema.linqGroupRosters.id, rosterId));

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    expect(await notice()).toEqual({ outcome: 'sent' });
    expect(sends.to).toEqual([one.phones[0]]);
    expect(await ledgerKeys(one.familyId)).toEqual([OLD_QUIET_KEY]);

    await pointRosterAt(two);
    expect(await notice()).toEqual({ outcome: 'already_sent' });
    expect(sends.to).toHaveLength(1);

    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    expect(await notice()).toEqual({ outcome: 'sent' });
    expect(sends.to).toEqual([one.phones[0], two.phones[0]]);
    expect(await ledgerKeys(two.familyId)).toEqual([
      `linq:group_quiet_notice:${two.familyId}:${QUIET_CHAT}`,
    ]);
    expect(await notice()).toEqual({ outcome: 'already_sent' });
    expect(sends.to).toHaveLength(2);

    await pointRosterAt(one);
    expect(await notice()).toEqual({ outcome: 'already_sent' });
    expect(sends.to).toHaveLength(2);
  });
});

describe('the clash poll key', () => {
  const lane = LANES.find((row) => row.name === 'clash') as Lane;

  beforeEach(() => {
    armLane(lane);
    vi.stubEnv('LINQ_POLLS', 'on');
    setGroupConflictWriter({
      async write(input) {
        return { text: 'FAKE clash line', figureItOut: input.poll ? 'FAKE pass option' : null };
      },
    });
  });

  it('flag on: a hash per family, with no family id in it', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    await lane.seed(a);
    await lane.seed(b);
    const wire = householdWire();

    for (const seeded of [a, b]) {
      await narrateHouseholdCalendar(db.database, {
        familyId: seeded.familyId,
        now: lane.now,
        fetch: wire.fetch,
      });
    }

    const [keyA] = wire.pollKeys(a.chatId);
    const [keyB] = wire.pollKeys(b.chatId);
    expect(keyA).toMatch(/^poll:[0-9a-f]{64}$/);
    expect(keyB).toMatch(/^poll:[0-9a-f]{64}$/);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toContain(a.familyId);
    expect(keyB).not.toContain(b.familyId);
  });

  it('flag off: the key as it was', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    const a = await seedHousehold(HOUSEHOLD_A);
    await lane.seed(a);
    const wire = householdWire();

    await narrateHouseholdCalendar(db.database, {
      familyId: a.familyId,
      now: lane.now,
      fetch: wire.fetch,
    });

    const [row] = await ledger(a.familyId);
    expect(row?.dedupeKey).toMatch(/^linq-group:clash:[0-9a-f]{32}$/);
    expect(wire.pollKeys(a.chatId)).toEqual([`poll:${row?.dedupeKey}`]);
  });
});

describe("one coach's invite, accepted by a parent in each family", () => {
  const invite = {
    eventId: 'coach-invite-1',
    title: 'Maya swim lesson',
    updated: 'stamp-1',
    status: 'confirmed',
    start: { dateTime: '2026-09-26T19:00:00.000Z' },
    end: { dateTime: '2026-09-26T20:00:00.000Z' },
    standing: 'accepted',
  } as const;

  async function acceptAndNarrate(seeded: Seeded, wire: Wire): Promise<void> {
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [invite],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
  }

  it('flag on: both groups hear about it', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'true');
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    const wire = householdWire();

    await acceptAndNarrate(a, wire);
    await acceptAndNarrate(b, wire);

    expect(wire.texts(a.chatId)).toBe(1);
    expect(wire.texts(b.chatId)).toBe(1);
    expect(await ledgerKeys(a.familyId)).toEqual([`linq-group:${a.familyId}:kids:coach-invite-1`]);
    expect(await ledgerKeys(b.familyId)).toEqual([`linq-group:${b.familyId}:kids:coach-invite-1`]);
  });

  it('flag off: the second group hears nothing, as before', async () => {
    vi.stubEnv(FAMILY_SCOPED_SEND_KEYS_ENV, 'false');
    const a = await seedHousehold(HOUSEHOLD_A);
    const b = await seedHousehold(HOUSEHOLD_B);
    const wire = householdWire();

    await acceptAndNarrate(a, wire);
    await acceptAndNarrate(b, wire);

    expect(wire.texts(a.chatId)).toBe(1);
    expect(wire.texts(b.chatId)).toBe(0);
    expect(await ledgerKeys(a.familyId)).toEqual(['linq-group:kids:coach-invite-1']);
    expect(await ledgerKeys(b.familyId)).toEqual([]);
  });
});
