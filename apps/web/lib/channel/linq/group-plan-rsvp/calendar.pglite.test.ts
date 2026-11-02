import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadIcsFeed, mintIcsToken } from '~/lib/loop/ics-feed';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { handleLinqInboundRequest } from '../inbound';
import { postgresGroupPlanCalendarWriter, postgresGroupPlanHouseholds } from './calendar';
import { considerCalendarTapback, considerPrivateCalendarReply } from './inbound';
import { createPostgresGroupPlanRsvpStore } from './store';
import { takeGroupPlanRsvpTurn } from './turn';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-two-households';
const PRIYA = '+14165550111';
const SAM = '+14165550112';
const NOW = new Date('2026-10-28T16:00:00.000Z');

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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function parent(input: { name: string; phone: string; chat?: string; language?: string }) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: input.name,
      provinceOrState: 'ON',
      primaryLanguage: input.language ?? 'en',
      ...(input.chat ? { linqGroupChatId: input.chat } : {}),
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `imessage:${input.name}`,
      name: input.name,
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
}

describe('postgres household calendar copy', () => {
  it('resolves each parent to their own family and writes only the one that agreed', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM });
    const [consent] = await db.database
      .insert(schema.consentRecords)
      .values({
        userId: sam.userId,
        familyId: sam.familyId,
        consentType: 'multi_family_group',
        granted: true,
        consentScope: CHAT,
        policyVersion: 'test',
      })
      .returning({ id: schema.consentRecords.id });
    await db.database.insert(schema.linqMultiFamilyJoins).values({
      chatId: CHAT,
      familyId: sam.familyId,
      joinedByUserId: sam.userId,
      consentRecordId: consent?.id,
      joinedAt: NOW,
    });

    const homes = postgresGroupPlanHouseholds(db.database);
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
    });
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: CHAT,
      familyId: sam.familyId,
      userId: sam.userId,
      phoneE164Encrypted: encryptString(SAM),
      phoneE164Hash: phoneBlindIndex(SAM),
      role: 'parent',
      seatedAt: NOW,
    });
    expect(await homes.resolve({ chatId: CHAT, userId: sam.userId })).toEqual({
      status: 'one',
      familyId: sam.familyId,
    });
    expect(await homes.resolve({ chatId: CHAT, userId: null })).toEqual({ status: 'none' });
    await db.database
      .update(schema.linqGroupMembers)
      .set({ removedAt: NOW })
      .where(eq(schema.linqGroupMembers.userId, priya.userId));
    expect(await homes.resolve({ chatId: CHAT, userId: priya.userId })).toEqual({ status: 'none' });
    await db.database
      .update(schema.linqGroupMembers)
      .set({ removedAt: null })
      .where(eq(schema.linqGroupMembers.userId, priya.userId));
    expect(await homes.resolve({ chatId: CHAT, userId: priya.userId })).toEqual({
      status: 'one',
      familyId: priya.familyId,
    });

    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    const writer = postgresGroupPlanCalendarWriter(db.database);
    const groupCalls: { chatId?: string }[] = [];
    const privateCalls: object[] = [];
    const base = {
      store,
      composer: fakeGroupPlanRsvpComposer(),
      send: async (line: { chatId: string }) => {
        groupCalls.push(line);
        return { providerMessageId: 'm' };
      },
      privateSend: {
        async send(line: object) {
          expect(line).not.toHaveProperty('chatId');
          privateCalls.push(line);
          return { status: 'sent' as const, providerMessageId: `priv-${privateCalls.length}` };
        },
      },
      enabled: () => true,
      calendarEnabled: () => true,
      households: homes,
      calendar: writer,
      consentReader: {
        read: async () => ({ decision: 'ok' as const, confidence: 'high' as const }),
      },
      reader: {
        read: async () => {
          throw new Error('rsvp reader must not run once the calendar ask is answered');
        },
      },
    };

    const asked = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: priya.userId,
        text: 'we are in',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        ...base,
        reader: {
          read: async () => ({
            intent: 'rsvp' as const,
            planTitle: null,
            startsAt: null,
            location: null,
            deadline: null,
            response: 'yes' as const,
            headcount: 1,
            householdLabel: null,
            coversNames: [],
            confidence: 'high' as const,
          }),
        },
      },
    );
    expect(asked).toMatchObject({ calendar: { status: 'asked' } });

    const rowsAfterAsk = await db.database.select().from(schema.familyEvents);
    expect(rowsAfterAsk).toHaveLength(0);

    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
    const reply = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer: fakeGroupPlanRsvpComposer(),
        consentReader: {
          read: async () => ({ decision: 'ok', confidence: 'high' }),
        },
      },
      { senderUserId: priya.userId, senderName: 'Priya', text: 'please add it' },
    );
    expect(reply.handled).toBe(true);

    const copies = await db.database
      .select({
        familyId: schema.familyEvents.familyId,
        title: schema.familyEvents.title,
        source: schema.familyEvents.source,
      })
      .from(schema.familyEvents);
    expect(copies).toEqual([
      { familyId: priya.familyId, title: 'Saturday picnic', source: 'placement' },
    ]);
    expect(copies.some((row) => row.familyId === sam.familyId)).toBe(false);

    const consentRow = await store.loadCalendarConsent(plan.id, priya.familyId);
    expect(consentRow?.status).toBe('written');
    expect(consentRow?.familyId).toBe(priya.familyId);
    expect(await store.loadCalendarConsent(plan.id, sam.familyId)).toBeNull();

    const audits = await db.database
      .select({
        action: schema.auditLog.actionTaken,
        familyId: schema.auditLog.familyId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, priya.familyId));
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'linq_group_plan_calendar_asked',
        'linq_group_plan_calendar_written',
      ]),
    );
    expect(groupCalls).toEqual([]);
    expect(privateCalls).toHaveLength(1);
    expect(privateCalls[0]).toMatchObject({ kind: 'calendar_ask', familyId: priya.familyId });
    expect(privateCalls.every((line) => !('chatId' in line))).toBe(true);
  });

  it('writes one family_events row and that family ICS feed, and nothing else', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM });
    await db.database.insert(schema.familyEvents).values({
      familyId: priya.familyId,
      title: 'Priya added this',
      startsAt: new Date('2026-11-02T15:00:00.000Z'),
      source: 'parent',
    });
    const priyaFeed = await mintIcsToken(db.database, priya.familyId, 'feed_subscription');
    const samFeed = await mintIcsToken(db.database, sam.familyId, 'feed_subscription');
    const before = await tableCounts();
    const writer = postgresGroupPlanCalendarWriter(db.database);
    const written = await writer.write({
      planId: '11111111-1111-4111-8111-111111111111',
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
    });
    expect(written.status).toBe('written');
    const after = await tableCounts();
    const changed = [...after.entries()].filter(([table, count]) => count !== before.get(table));
    expect(changed).toEqual([['family_events', (before.get('family_events') ?? 0) + 1]]);

    const rows = await db.database.select().from(schema.familyEvents);
    const placed = rows.filter((row) => row.title === 'Saturday picnic');
    expect(placed).toHaveLength(1);
    expect(placed[0]?.familyId).toBe(priya.familyId);
    expect(placed[0]?.source).toBe('placement');
    expect(placed[0]?.placedGoogleEventId).toBeNull();
    expect(rows.filter((row) => row.familyId === sam.familyId)).toEqual([]);
    expect(rows.filter((row) => row.title === 'Priya added this')).toHaveLength(1);

    const priyaIcs = await loadIcsFeed(db.database, priyaFeed.token, NOW);
    const samIcs = await loadIcsFeed(db.database, samFeed.token, NOW);
    expect(priyaIcs).toContain('Saturday picnic');
    expect(priyaIcs).toContain('Priya added this');
    expect(samIcs ?? '').not.toContain('Saturday picnic');

    const removed = await writer.remove({
      planId: '11111111-1111-4111-8111-111111111111',
      familyId: priya.familyId,
    });
    expect(removed.status).toBe('removed');
    const live = await db.database
      .select({ title: schema.familyEvents.title, deletedAt: schema.familyEvents.deletedAt })
      .from(schema.familyEvents);
    expect(live.find((row) => row.title === 'Saturday picnic')?.deletedAt).not.toBeNull();
    expect(live.find((row) => row.title === 'Priya added this')?.deletedAt).toBeNull();
    const afterRemoval = await loadIcsFeed(db.database, priyaFeed.token, NOW);
    expect(afterRemoval).not.toContain('Saturday picnic');
    expect(afterRemoval).toContain('Priya added this');
    expect((await loadIcsFeed(db.database, samFeed.token, NOW)) ?? '').not.toContain(
      'Saturday picnic',
    );
  });
});

describe('open calendar asks follow the current seat', () => {
  it('hides an ask once the parent has left the chat', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
    });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    await store.claimCalendarAsk({
      planId: plan.id,
      familyId: priya.familyId,
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: NOW,
    });
    expect(await store.listOpenCalendarAsks(priya.userId)).toHaveLength(1);
    await db.database
      .update(schema.linqGroupMembers)
      .set({ removedAt: NOW })
      .where(eq(schema.linqGroupMembers.userId, priya.userId));
    expect(await store.listOpenCalendarAsks(priya.userId)).toEqual([]);
  });
});

describe('the private reply and a tapback use the household language', () => {
  it('writes the confirmation in the language stored for the family', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: 'fr' });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
    });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    await store.claimCalendarAsk({
      planId: plan.id,
      familyId: priya.familyId,
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
    const reply = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-fr', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      { senderUserId: priya.userId, senderName: 'Priya', text: 'oui, mets-le' },
    );
    expect(reply.handled).toBe(true);
    expect(composer.calls.map((call) => call.input.language)).toEqual(['fr']);
  });

  it('writes the tapback confirmation in the language stored for the family', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: 'zh' });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
    });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    await store.claimCalendarAsk({
      planId: plan.id,
      familyId: priya.familyId,
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: NOW,
    });
    await store.setCalendarAskMessage(plan.id, priya.familyId, 'ask-msg');
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
    const reply = await considerCalendarTapback(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-zh', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        messageId: 'ask-msg',
        tapback: 'love',
      },
    );
    expect(reply.handled).toBe(true);
    expect(composer.calls.map((call) => call.input.language)).toEqual(['zh']);
  });
});

describe('a 1:1 reply reaches the calendar ask before ordinary intake', () => {
  it('writes that household calendar and does not open the 1:1 door', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: 'fr' });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
    });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    await store.claimCalendarAsk({
      planId: plan.id,
      familyId: priya.familyId,
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    const oneToOne: string[] = [];
    const key = Buffer.alloc(32, 9);
    const secret = `whsec_${key.toString('base64')}`;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', secret);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
    const body = JSON.stringify({
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_calendar',
      created_at: NOW.toISOString(),
      data: {
        chat: { id: 'chat-private', is_group: false },
        id: 'msg-private-ok',
        direction: 'inbound',
        sender_handle: { handle: PRIYA, is_me: false },
        parts: [{ type: 'text', value: 'oui, mets-le' }],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const mac = createHmac('sha256', key).update(`evt_calendar.${ts}.${body}`).digest('base64');
    const res = await handleLinqInboundRequest(
      new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'evt_calendar',
          'webhook-timestamp': ts,
          'webhook-signature': `v1,${mac}`,
        },
        body,
      }),
      {
        database: db.database,
        intake: () => {
          throw new Error('routeOneToOne must not run');
        },
        enqueue: async () => {},
        log: { info: () => {}, warn: () => {}, error: () => {} },
        countOutcome: async () => {},
        now: () => NOW,
        markRead: async () => ({ status: 'accepted' }),
        groupPlanRsvpComposer: composer,
        groupPlanCalendarConsentReader: {
          read: async () => ({ decision: 'ok', confidence: 'high' }),
        },
        oneToOne: {
          text: async (input) => {
            oneToOne.push(input.body);
            return { providerMessageId: 'priv-door', chatId: 'chat-private' };
          },
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'group_plan_calendar_written' });
    expect(composer.calls.map((call) => call.input.language)).toEqual(['fr']);
    expect(oneToOne).toHaveLength(1);
    const copies = await db.database
      .select({ familyId: schema.familyEvents.familyId })
      .from(schema.familyEvents);
    expect(copies).toEqual([{ familyId: priya.familyId }]);
  });
});

async function tableCounts(): Promise<Map<string, number>> {
  const listed = (await db.database.execute(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  )) as unknown as { rows: { tablename: string }[] };
  const counts = new Map<string, number>();
  for (const row of listed.rows) {
    const name = row.tablename;
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    const counted = (await db.database.execute(
      sql.raw(`select count(*)::int as n from "${name}"`),
    )) as unknown as { rows: { n: number }[] };
    counts.set(name, Number(counted.rows[0]?.n ?? 0));
  }
  return counts;
}
