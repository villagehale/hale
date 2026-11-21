import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadIcsFeed, mintIcsToken } from '~/lib/loop/ics-feed';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { DROP_SINGLE_OPEN_PLAN_INDEX, seedTextedHale } from '~/lib/testing/group-scenes';
import { handleLinqInboundRequest } from '../inbound';
import { postgresGroupPlanCalendarWriter, postgresGroupPlanHouseholds } from './calendar';
import {
  considerCalendarTapback,
  considerGroupPlanRsvp,
  considerPrivateCalendarReply,
} from './inbound';
import { createPostgresGroupPlanRsvpStore } from './store';
import { takeGroupPlanRsvpTurn } from './turn';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-two-households';
const PRIVATE_CHAT = 'chat-private';
const PRIYA = '+14165550111';
const SAM = '+14165550112';
const NOW = new Date('2026-10-28T16:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  await db.exec(DROP_SINGLE_OPEN_PLAN_INDEX);
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function parent(input: {
  name: string;
  phone: string;
  chat?: string;
  language?: string;
  /** False: this parent has never texted Hale 1:1. */
  texted?: boolean;
}) {
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
  if (input.texted !== false) {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: userId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerChatId: `dm-${userId}`,
      inGroup: false,
      status: 'delivered',
      sentAt: new Date(NOW.getTime() - 86_400_000),
      createdAt: new Date(NOW.getTime() - 86_400_000),
    });
  }
  return { familyId, userId };
}

async function seatInSharedChat(input: {
  chatId: string;
  familyId: string;
  userId: string;
  phone: string;
}): Promise<void> {
  const [consent] = await db.database
    .insert(schema.consentRecords)
    .values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'multi_family_group',
      granted: true,
      consentScope: input.chatId,
      policyVersion: 'test',
    })
    .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.linqMultiFamilyJoins).values({
    chatId: input.chatId,
    familyId: input.familyId,
    joinedByUserId: input.userId,
    consentRecordId: consent?.id,
    joinedAt: NOW,
  });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: input.chatId,
    familyId: input.familyId,
    userId: input.userId,
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    role: 'parent',
    seatedAt: NOW,
  });
}

/** A line Hale sent this parent, as the 1:1 door ledgers it. */
async function haleLine(input: {
  familyId: string;
  userId: string;
  chatId: string;
  messageId: string;
  at: Date;
}): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.userId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      providerMessageId: input.messageId,
      providerChatId: input.chatId,
      status: 'sent',
      sentAt: input.at,
      createdAt: input.at,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

/** The private ask went out in the parent's 1:1 and is the newest line there. */
async function askWasSent(
  store: ReturnType<typeof createPostgresGroupPlanRsvpStore>,
  input: { planId: string; familyId: string; userId: string; messageId: string; at: Date },
): Promise<void> {
  await store.setCalendarAskMessage(input.planId, input.familyId, input.messageId);
  await haleLine({ ...input, chatId: PRIVATE_CHAT });
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
        mayOpen: async () => true,
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
            planKey: 'p1',
            replacesPlanKey: null,
            addressed: false,
          }),
        },
      },
    );
    expect(asked).toMatchObject({ calendar: { status: 'asked' } });

    const rowsAfterAsk = await db.database.select().from(schema.familyEvents);
    expect(rowsAfterAsk).toHaveLength(0);
    await haleLine({
      ...priya,
      chatId: PRIVATE_CHAT,
      messageId: 'priv-1',
      at: NOW,
    });

    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const reply = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer: fakeGroupPlanRsvpComposer(),
        consentReader: {
          read: async () => ({ decision: 'ok', confidence: 'high' }),
        },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'please add it',
      },
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

  it('lists only the household the seat belongs to when the parent is in two families', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM });
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other home', provinceOrState: 'ON', primaryLanguage: 'en' })
      .returning({ id: schema.families.id });
    const otherFamilyId = other?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: otherFamilyId, userId: sam.userId, role: 'co_parent' });
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
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: CHAT,
      familyId: sam.familyId,
      userId: sam.userId,
      phoneE164Encrypted: encryptString(SAM),
      phoneE164Hash: phoneBlindIndex(SAM),
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
    for (const familyId of [sam.familyId, otherFamilyId]) {
      await store.claimCalendarAsk({
        planId: plan.id,
        familyId,
        memberKey: 'sam',
        displayName: 'Sam',
        householdLabel: null,
        now: NOW,
      });
    }

    const open = await store.listOpenCalendarAsks(sam.userId);
    expect(open.map((item) => item.consent.familyId)).toEqual([sam.familyId]);
  });

  it('lists nothing when the parent holds live seats for two households in one chat', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM });
    const [other] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Other home', provinceOrState: 'ON', primaryLanguage: 'en' })
      .returning({ id: schema.families.id });
    const otherFamilyId = other?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: otherFamilyId, userId: sam.userId, role: 'co_parent' });
    for (const familyId of [sam.familyId, otherFamilyId]) {
      const [consent] = await db.database
        .insert(schema.consentRecords)
        .values({
          userId: sam.userId,
          familyId,
          consentType: 'multi_family_group',
          granted: true,
          consentScope: CHAT,
          policyVersion: 'test',
        })
        .returning({ id: schema.consentRecords.id });
      await db.database.insert(schema.linqMultiFamilyJoins).values({
        chatId: CHAT,
        familyId,
        joinedByUserId: sam.userId,
        consentRecordId: consent?.id,
        joinedAt: NOW,
      });
    }
    // A phone holds at most one live seat per chat in each seat table, so the two
    // households are seated through the two tables.
    await db.database.insert(schema.linqMultiFamilyMembers).values({
      chatId: CHAT,
      familyId: sam.familyId,
      userId: sam.userId,
      phoneE164Encrypted: encryptString(SAM),
      phoneE164Hash: phoneBlindIndex(SAM),
      role: 'parent',
      seatedAt: NOW,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: otherFamilyId,
      chatId: CHAT,
      userId: sam.userId,
      phoneE164Encrypted: encryptString(SAM),
      phoneE164Hash: phoneBlindIndex(SAM),
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
    for (const familyId of [sam.familyId, otherFamilyId]) {
      await store.claimCalendarAsk({
        planId: plan.id,
        familyId,
        memberKey: 'sam',
        displayName: 'Sam',
        householdLabel: null,
        now: NOW,
      });
    }

    expect(
      await postgresGroupPlanHouseholds(db.database).resolve({ chatId: CHAT, userId: sam.userId }),
    ).toEqual({ status: 'ambiguous' });
    expect(await store.listOpenCalendarAsks(sam.userId)).toEqual([]);
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
    await askWasSent(store, {
      planId: plan.id,
      familyId: priya.familyId,
      userId: priya.userId,
      messageId: 'ask-msg',
      at: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
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
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'oui, mets-le',
      },
    );
    expect(reply.handled).toBe(true);
    expect(composer.calls.map((call) => call.input.language)).toEqual(['fr']);
    // The primary parent's stored zone: 16:00Z on Nov 1 2026 is 11:00 AM EST.
    const facts = composer.calls[0]?.input.facts;
    expect(facts && 'startsAt' in facts ? facts.startsAt : 'missing').toBe(
      'Sun, Nov 1 at 11:00 AM',
    );
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
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
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

  it('follows the reply when the household has no stored language', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: '' });
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
    await askWasSent(store, {
      planId: plan.id,
      familyId: priya.familyId,
      userId: priya.userId,
      messageId: 'ask-msg',
      at: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    const words = 'Oui, mets-le sur notre calendrier';
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const reply = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-words', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      { senderUserId: priya.userId, senderName: 'Priya', chatId: PRIVATE_CHAT, text: words },
    );
    expect(reply.handled).toBe(true);
    expect(composer.calls[0]?.input).toMatchObject({ language: null, parentWords: words });
    expect(JSON.stringify(composer.calls[0]?.input)).not.toContain('"language":"en"');
  });

  it('does not invent English for a tapback when no language is stored', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: '' });
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
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const reply = await considerCalendarTapback(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-tap', chatId: null }),
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
    expect(composer.calls[0]?.input).toMatchObject({ language: null, parentWords: null });
    expect(JSON.stringify(composer.calls[0]?.input)).not.toContain('"language":"en"');
  });

  it('asks in the language of the RSVP when the household has no stored language', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, language: '' });
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
    await store.createPlan({
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
    const composer = fakeGroupPlanRsvpComposer();
    const words = 'Oui, on est partants';
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        reader: {
          read: async () => ({
            intent: 'rsvp',
            planTitle: null,
            startsAt: null,
            location: null,
            deadline: null,
            response: 'yes',
            headcount: 1,
            householdLabel: null,
            coversNames: [],
            confidence: 'high',
            planKey: 'p1',
            replacesPlanKey: null,
            addressed: false,
          }),
        },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-ask', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderUserId: priya.userId,
        text: words,
        tapback: null,
      },
    );
    const voice = composer.calls.filter(
      (call) => call.input.skill === 'group-plan-rsvp-calendar-voice',
    );
    expect(voice[0]?.input).toMatchObject({ language: null, parentWords: words });
    expect(JSON.stringify(voice[0]?.input)).not.toContain('"language":"en"');
  });

  it('uses the household the calendar step picked, not the first membership', async () => {
    const userId = '00000000-0000-4000-8000-0000000000b1';
    const elsewhereId = '00000000-0000-4000-8000-0000000000a1';
    const homeId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const phone = '+14165550199';
    await db.database.insert(schema.users).values({
      id: userId,
      externalAuthId: 'imessage:two-homes',
      name: 'Priya Two',
      timezone: 'America/Toronto',
    });
    await db.database.insert(schema.families).values({
      id: elsewhereId,
      displayName: 'Elsewhere',
      provinceOrState: 'ON',
      primaryLanguage: 'zh',
    });
    await db.database.insert(schema.familyMembers).values({
      familyId: elsewhereId,
      userId,
      role: 'primary_parent',
    });
    await db.database.insert(schema.families).values({
      id: homeId,
      displayName: 'Home',
      provinceOrState: 'ON',
      primaryLanguage: 'fr',
      linqGroupChatId: CHAT,
    });
    await db.database.insert(schema.familyMembers).values({
      familyId: homeId,
      userId,
      role: 'co_parent',
    });
    await db.database.insert(schema.parentChannels).values({
      userId,
      familyId: homeId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    await seedTextedHale(db.database, { familyId: homeId, userId, at: NOW });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: homeId,
      chatId: CHAT,
      userId,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      role: 'parent',
      seatedAt: NOW,
    });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    await store.createPlan({
      chatId: CHAT,
      familyId: homeId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: userId,
      expected: [],
      now: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        reader: {
          read: async () => ({
            intent: 'rsvp',
            planTitle: null,
            startsAt: null,
            location: null,
            deadline: null,
            response: 'yes',
            headcount: 1,
            householdLabel: null,
            coversNames: [],
            confidence: 'high',
            planKey: 'p1',
            replacesPlanKey: null,
            addressed: false,
          }),
        },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-home', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        chatId: CHAT,
        senderHandle: phone,
        senderUserId: userId,
        text: 'we are in',
        tapback: null,
      },
    );
    const voice = composer.calls.filter(
      (call) => call.input.skill === 'group-plan-rsvp-calendar-voice',
    );
    expect(voice[0]?.input.language).toBe('fr');
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
    await askWasSent(store, {
      planId: plan.id,
      familyId: priya.familyId,
      userId: priya.userId,
      messageId: 'ask-msg',
      at: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    const oneToOne: string[] = [];
    const key = Buffer.alloc(32, 9);
    const secret = `whsec_${key.toString('base64')}`;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', secret);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
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

describe('a claimed group with no member seat', () => {
  it('still asks the covering parent, and a parent who left does not get an ask', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    await store.createPlan({
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
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const yes = {
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
      planKey: 'p1',
      replacesPlanKey: null,
      addressed: false,
    };
    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
        composer,
        reader: { read: async () => yes },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-claim', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderUserId: priya.userId,
        text: 'in',
        tapback: null,
      },
    );
    expect(
      composer.calls.some((call) => call.input.skill === 'group-plan-rsvp-calendar-voice'),
    ).toBe(true);

    await db.database.insert(schema.linqGroupMembers).values({
      familyId: priya.familyId,
      chatId: CHAT,
      userId: priya.userId,
      phoneE164Encrypted: encryptString(PRIYA),
      phoneE164Hash: phoneBlindIndex(PRIYA),
      role: 'parent',
      seatedAt: NOW,
      removedAt: NOW,
    });
    expect(
      await postgresGroupPlanHouseholds(db.database).resolve({
        chatId: CHAT,
        userId: priya.userId,
      }),
    ).toEqual({ status: 'none' });
  });
});

describe('Hale never opens a 1:1 cold', () => {
  async function yesFrom(priya: { familyId: string; userId: string }) {
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
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const sent: string[] = [];
    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
        composer,
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
            planKey: 'p1',
            replacesPlanKey: null,
            addressed: false,
          }),
        },
        oneToOne: {
          text: async ({ body }) => {
            sent.push(body);
            return { providerMessageId: 'priv-1', chatId: null };
          },
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      { chatId: CHAT, senderHandle: PRIYA, senderUserId: priya.userId, text: 'in', tapback: null },
    );
    const consent = await store.loadCalendarConsent(plan.id, priya.familyId);
    const withdrawn = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_calendar_withdrawn'));
    return { sent, consent, withdrawn };
  }

  it('a yes from a parent who never texted Hale opens no ask and leaves no ask row', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT, texted: false });
    const { sent, consent, withdrawn } = await yesFrom(priya);
    expect(sent).toEqual([]);
    expect(consent).toBeNull();
    expect(withdrawn).toEqual([]);
  });

  it('the same yes from a parent who has texted Hale gets the ask (positive control)', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const { sent, consent } = await yesFrom(priya);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('calendar_ask');
    expect(consent?.status).toBe('asked');
  });
});

describe('a 1:1 reply that cannot be an answer to the open ask', () => {
  const ASKED_AT = new Date(NOW.getTime() + 30_000);

  async function openAsk(title: string) {
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
      title,
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: null,
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
    await askWasSent(store, { planId: plan.id, ...priya, messageId: 'ask-1', at: ASKED_AT });
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const ports = {
      database: db.database,
      now: new Date(NOW.getTime() + 60_000),
      composer: fakeGroupPlanRsvpComposer(),
      consentReader: {
        read: async () => ({ decision: 'ok' as const, confidence: 'high' as const }),
      },
      oneToOne: {
        text: async () => ({ providerMessageId: 'priv-ok', chatId: PRIVATE_CHAT }),
        link: async () => ({ providerMessageId: 'link' }),
      },
    };
    const reply = (text: string, sentAt: Date | null) =>
      considerPrivateCalendarReply(ports, {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text,
        sentAt,
      });
    const status = async () =>
      (await store.loadCalendarConsent(plan.id, priya.familyId))?.status;
    return { priya, store, reply, status };
  }

  it('a yes written before the ask went out does not answer it', async () => {
    const { reply, status } = await openAsk('Saturday picnic');
    const out = await reply('yes', new Date(ASKED_AT.getTime() - 5_000));
    expect(out.handled).toBe(false);
    expect(await status()).toBe('asked');
    expect(await db.database.select().from(schema.familyEvents)).toHaveLength(0);
  });

  it('the same yes written after the ask answers it (positive control)', async () => {
    const { reply, status } = await openAsk('Saturday picnic');
    const out = await reply('yes', new Date(ASKED_AT.getTime() + 5_000));
    expect(out.handled).toBe(true);
    expect(await status()).toBe('written');
  });

  it('a reply naming a closed plan by a word the open ask lacks does not answer it', async () => {
    const { priya, reply, status } = await openAsk('Saturday picnic');
    await db.database.insert(schema.linqGroupPlans).values({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'museum visit',
      expectedCount: 0,
      createdByUserId: priya.userId,
      closedAt: NOW,
    });
    const out = await reply('yes the museum', new Date(ASKED_AT.getTime() + 5_000));
    expect(out.handled).toBe(false);
    expect(await status()).toBe('asked');
  });

  it('a reply naming the open ask still answers it with a closed plan in the chat (positive control)', async () => {
    const { priya, reply, status } = await openAsk('Saturday picnic');
    await db.database.insert(schema.linqGroupPlans).values({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'museum visit',
      expectedCount: 0,
      createdByUserId: priya.userId,
      closedAt: NOW,
    });
    const out = await reply('yes the picnic', new Date(ASKED_AT.getTime() + 5_000));
    expect(out.handled).toBe(true);
    expect(await status()).toBe('written');
  });
});

describe('a 1:1 yes after Hale asked something else', () => {
  it('is not read as calendar consent, and is once the ask is the last line again', async () => {
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
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const reads: string[] = [];
    const ports = {
      database: db.database,
      now: new Date(NOW.getTime() + 60_000),
      composer: fakeGroupPlanRsvpComposer(),
      consentReader: {
        read: async (input: { text: string }) => {
          reads.push(input.text);
          return { decision: 'ok' as const, confidence: 'high' as const };
        },
      },
      oneToOne: {
        text: async () => ({ providerMessageId: 'priv-ok', chatId: PRIVATE_CHAT }),
        link: async () => ({ providerMessageId: 'link' }),
      },
    };
    const input = {
      senderUserId: priya.userId,
      senderName: 'Priya',
      chatId: PRIVATE_CHAT,
      text: 'yes',
    };
    // No ask id and no line sent: nothing to answer.
    expect((await considerPrivateCalendarReply(ports, input)).handled).toBe(false);

    await askWasSent(store, { planId: plan.id, ...priya, messageId: 'ask-picnic', at: NOW });
    const laterQuestion = await haleLine({
      ...priya,
      chatId: PRIVATE_CHAT,
      messageId: 'coach-swim',
      at: new Date(NOW.getTime() + 30_000),
    });

    const bare = await considerPrivateCalendarReply(ports, input);
    expect(bare.handled).toBe(false);
    expect(reads).toEqual([]);
    expect((await store.loadCalendarConsent(plan.id, priya.familyId))?.status).toBe('asked');
    expect(await db.database.select().from(schema.familyEvents)).toHaveLength(0);

    // A newer line in the group chat is not the 1:1 thread, so it does not hide the ask.
    await db.database
      .delete(schema.channelMessages)
      .where(eq(schema.channelMessages.id, laterQuestion));
    await haleLine({
      ...priya,
      chatId: CHAT,
      messageId: 'group-tally',
      at: new Date(NOW.getTime() + 30_000),
    });
    const answered = await considerPrivateCalendarReply(ports, input);
    expect(answered.handled).toBe(true);
    expect(reads).toEqual(['yes']);
    expect((await store.loadCalendarConsent(plan.id, priya.familyId))?.status).toBe('written');
  });
});

describe('a private reply among calendar asks', () => {
  it('reopens a declined ask when the reader says they brought it back', async () => {
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
    await store.markCalendarDeclined({
      planId: plan.id,
      familyId: priya.familyId,
      actorUserId: priya.userId,
      now: NOW,
    });
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const quiet = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 30_000),
        composer,
        consentReader: { read: async () => ({ decision: 'not_this', confidence: 'high' }) },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'we are still coming',
      },
    );
    expect(quiet.handled).toBe(false);
    expect((await store.loadCalendarConsent(plan.id, priya.familyId))?.status).toBe('declined');

    const again = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        consentReader: { read: async () => ({ decision: 'reopen', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-reopen', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'put the picnic on our calendar',
      },
    );
    expect(again.handled).toBe(true);
    expect((await store.loadCalendarConsent(plan.id, priya.familyId))?.status).toBe('asked');
    expect(composer.calls.some((call) => call.input.kind === 'calendar_ask')).toBe(true);
  });

  it('answers the one plan the reply is about when two asks are open', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
    const [other] = await db.database
      .insert(schema.families)
      .values({
        displayName: 'Other chat',
        provinceOrState: 'ON',
        primaryLanguage: 'en',
        linqGroupChatId: 'chat-museum',
      })
      .returning({ id: schema.families.id });
    const otherId = other?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId: otherId,
      userId: priya.userId,
      role: 'co_parent',
    });
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
    const picnic = await store.createPlan({
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
    const museum = await store.createPlan({
      chatId: 'chat-museum',
      familyId: otherId,
      title: 'Museum Saturday',
      startsAt: new Date('2026-11-08T16:00:00.000Z'),
      location: 'the museum',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    for (const row of [
      { planId: picnic.id, familyId: priya.familyId },
      { planId: museum.id, familyId: otherId },
    ]) {
      await store.claimCalendarAsk({
        planId: row.planId,
        familyId: row.familyId,
        memberKey: 'priya',
        displayName: 'Priya',
        householdLabel: null,
        now: NOW,
      });
    }
    await askWasSent(store, {
      planId: picnic.id,
      familyId: priya.familyId,
      userId: priya.userId,
      messageId: 'ask-picnic',
      at: NOW,
    });
    await askWasSent(store, {
      planId: museum.id,
      familyId: otherId,
      userId: priya.userId,
      messageId: 'ask-museum',
      at: new Date(NOW.getTime() + 1_000),
    });
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    let sends = 0;
    const ports = {
      database: db.database,
      now: new Date(NOW.getTime() + 60_000),
      composer: fakeGroupPlanRsvpComposer(),
      consentReader: {
        read: async (input: { ask: { title: string } }) =>
          input.ask.title === 'Museum Saturday'
            ? { decision: 'ok' as const, confidence: 'high' as const }
            : { decision: 'not_this' as const, confidence: 'high' as const },
      },
      oneToOne: {
        text: async () => {
          sends += 1;
          return { providerMessageId: `priv-${sends}`, chatId: null };
        },
        link: async () => ({ providerMessageId: 'link' }),
      },
    };
    const whichComposer = fakeGroupPlanRsvpComposer();
    const both = await considerPrivateCalendarReply(
      {
        ...ports,
        composer: whichComposer,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'both of them',
      },
    );
    expect(both).toMatchObject({ handled: true, outcome: 'group_plan_calendar_unwritten' });
    expect((await store.loadCalendarConsent(picnic.id, priya.familyId))?.status).toBe('asked');
    expect((await store.loadCalendarConsent(museum.id, otherId))?.status).toBe('asked');
    // Nothing named which one: Hale asks, in a model-written line naming both plans.
    const which = whichComposer.calls.filter((call) => call.input.kind === 'calendar_which');
    expect(which).toHaveLength(1);
    expect(
      (which[0]?.input.facts as { choices?: { title: string }[] }).choices?.map((c) => c.title),
    ).toEqual(['Saturday picnic', 'Museum Saturday']);

    // A bare yes the reader would give to the newest ask still binds nothing on its own.
    const bare = await considerPrivateCalendarReply(
      {
        ...ports,
        now: new Date(NOW.getTime() + 90_000),
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
      },
      { senderUserId: priya.userId, senderName: 'Priya', chatId: PRIVATE_CHAT, text: 'yes' },
    );
    expect(bare.handled).toBe(true);
    expect((await store.loadCalendarConsent(museum.id, otherId))?.status).toBe('asked');
    expect((await store.loadCalendarConsent(picnic.id, priya.familyId))?.status).toBe('asked');

    // The reader alone deciding exactly one of the asks, with no plan named, binds nothing.
    const modelOnly = await considerPrivateCalendarReply(
      { ...ports, now: new Date(NOW.getTime() + 100_000) },
      { senderUserId: priya.userId, senderName: 'Priya', chatId: PRIVATE_CHAT, text: 'yes please' },
    );
    expect(modelOnly.handled).toBe(true);
    expect((await store.loadCalendarConsent(museum.id, otherId))?.status).toBe('asked');
    expect((await store.loadCalendarConsent(picnic.id, priya.familyId))?.status).toBe('asked');

    const chosen = await considerPrivateCalendarReply(
      { ...ports, now: new Date(NOW.getTime() + 120_000) },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: PRIVATE_CHAT,
        text: 'the museum one',
      },
    );
    expect(chosen.handled).toBe(true);
    expect((await store.loadCalendarConsent(museum.id, otherId))?.status).toBe('written');
    expect((await store.loadCalendarConsent(picnic.id, priya.familyId))?.status).toBe('asked');
  });
});

/** Priya holds two open calendar asks (picnic, then museum `gapMs` later, the last line). */
async function twoOpenAsks(gapMs: number) {
  const priya = await parent({ name: 'Priya', phone: PRIYA, chat: CHAT });
  const [other] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Other chat',
      provinceOrState: 'ON',
      primaryLanguage: 'en',
      linqGroupChatId: 'chat-museum',
    })
    .returning({ id: schema.families.id });
  const otherId = other?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: otherId, userId: priya.userId, role: 'co_parent' });
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
  const plan = (chatId: string, familyId: string, title: string) =>
    store.createPlan({
      chatId,
      familyId,
      title,
      startsAt: new Date('2026-11-08T16:00:00.000Z'),
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
  const picnic = await plan(CHAT, priya.familyId, 'Saturday picnic');
  const museum = await plan('chat-museum', otherId, 'Museum Saturday');
  const asks = [
    { planId: picnic.id, familyId: priya.familyId, messageId: 'ask-picnic', at: NOW },
    {
      planId: museum.id,
      familyId: otherId,
      messageId: 'ask-museum',
      at: new Date(NOW.getTime() + gapMs),
    },
  ];
  for (const ask of asks) {
    await store.claimCalendarAsk({
      planId: ask.planId,
      familyId: ask.familyId,
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: NOW,
    });
    await askWasSent(store, { ...ask, userId: priya.userId });
  }
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
  const ports = {
    database: db.database,
    now: new Date(NOW.getTime() + 120_000),
    composer: fakeGroupPlanRsvpComposer(),
    consentReader: { read: async () => ({ decision: 'ok' as const, confidence: 'high' as const }) },
    oneToOne: {
      text: async () => ({ providerMessageId: 'priv-one', chatId: null }),
      link: async () => ({ providerMessageId: 'link' }),
    },
  };
  const status = async () => ({
    picnic: (await store.loadCalendarConsent(picnic.id, priya.familyId))?.status,
    museum: (await store.loadCalendarConsent(museum.id, otherId))?.status,
  });
  return { priya, ports, status, store, museum, otherId };
}

describe('a 1:1 reply with several calendar asks open: only a named plan binds', () => {
  it.each([
    ['a bare yes, even long after the newest ask', 'yes'],
    ['a positional reference', 'yes to the first one'],
    ['a misspelled title', 'yes to the picnik'],
    ['a translated title', 'oui pour le pique-nique'],
  ])('%s binds nothing and Hale asks which', async (_label, text) => {
    const { priya, ports, status } = await twoOpenAsks(60_000);
    const reply = await considerPrivateCalendarReply(ports, {
      senderUserId: priya.userId,
      senderName: 'Priya',
      chatId: PRIVATE_CHAT,
      text,
    });
    expect(reply.handled).toBe(true);
    expect(await status()).toEqual({ picnic: 'asked', museum: 'asked' });
    expect(
      ports.composer.calls.filter((call) => call.input.kind === 'calendar_which'),
    ).toHaveLength(1);
  });

  it('a reply naming the older plan answers that one only', async () => {
    const { priya, ports, status } = await twoOpenAsks(60_000);
    const named = await considerPrivateCalendarReply(ports, {
      senderUserId: priya.userId,
      senderName: 'Priya',
      chatId: PRIVATE_CHAT,
      text: 'yes to the picnic',
    });
    expect(named.handled).toBe(true);
    expect(await status()).toEqual({ picnic: 'written', museum: 'asked' });
  });
});

describe('the which-plan line names no plan', () => {
  const WHICH_LINE = 'priv-one';

  async function askedWhich() {
    const asks = await twoOpenAsks(60_000);
    const reply = {
      senderUserId: asks.priya.userId,
      senderName: 'Priya',
      chatId: PRIVATE_CHAT,
    };
    await considerPrivateCalendarReply(asks.ports, { ...reply, text: 'yes' });
    expect(
      asks.ports.composer.calls.filter((call) => call.input.kind === 'calendar_which'),
    ).toHaveLength(1);
    const thumbsUp = (messageId: string) =>
      considerCalendarTapback(asks.ports, {
        senderUserId: asks.priya.userId,
        senderName: 'Priya',
        messageId,
        tapback: 'like',
      });
    const withdrawMuseum = () =>
      asks.store.releaseCalendarAsk(asks.museum.id, asks.otherId, asks.priya.userId, 'send_failed');
    const copies = async () => (await db.database.select().from(schema.familyEvents)).length;
    return { ...asks, reply, thumbsUp, withdrawMuseum, copies };
  }

  it('a thumbs-up on the which-plan line leaves both asks open and writes nothing', async () => {
    const { thumbsUp, status, copies } = await askedWhich();
    const tap = await thumbsUp(WHICH_LINE);
    expect(tap.handled).toBe(false);
    expect(await status()).toEqual({ picnic: 'asked', museum: 'asked' });
    expect(await copies()).toBe(0);
  });

  it('a thumbs-up on a line that asked about one plan still writes that plan', async () => {
    const { thumbsUp, status, copies } = await askedWhich();
    const tap = await thumbsUp('ask-museum');
    expect(tap.handled).toBe(true);
    expect(await status()).toEqual({ picnic: 'asked', museum: 'written' });
    expect(await copies()).toBe(1);
  });

  it('a thumbs-up on it still binds nothing once one of its plans is withdrawn', async () => {
    const { thumbsUp, withdrawMuseum, status, copies } = await askedWhich();
    expect(await withdrawMuseum()).toBe(true);
    const tap = await thumbsUp(WHICH_LINE);
    expect(tap.handled).toBe(false);
    expect((await status()).picnic).toBe('asked');
    expect(await copies()).toBe(0);
  });

  it('with one of its plans withdrawn, a bare yes binds nothing and naming the plan does', async () => {
    const { ports, reply, withdrawMuseum, status, copies } = await askedWhich();
    expect(await withdrawMuseum()).toBe(true);
    await considerPrivateCalendarReply(ports, { ...reply, text: 'yes' });
    expect((await status()).picnic).toBe('asked');
    expect(await copies()).toBe(0);

    const named = await considerPrivateCalendarReply(ports, {
      ...reply,
      text: 'yes to the picnic',
    });
    expect(named.handled).toBe(true);
    expect((await status()).picnic).toBe('written');
    expect(await copies()).toBe(1);
  });
});

describe('a which-plan line binds only the plans it asked about', () => {
  const OK = { decision: 'ok' as const, confidence: 'high' as const };
  const NOT_THIS = { decision: 'not_this' as const, confidence: 'high' as const };

  /** Priya holds one open ask per title, oldest first, in one household chat. */
  async function openAsksFor(titles: readonly string[]) {
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
    const planIds = new Map<string, string>();
    for (const [index, title] of titles.entries()) {
      const plan = await store.createPlan({
        chatId: CHAT,
        familyId: priya.familyId,
        title,
        startsAt: new Date('2026-11-08T16:00:00.000Z'),
        location: null,
        rsvpDeadlineAt: null,
        createdByUserId: priya.userId,
        expected: [],
        now: NOW,
      });
      planIds.set(title, plan.id);
      await store.claimCalendarAsk({
        planId: plan.id,
        familyId: priya.familyId,
        memberKey: 'priya',
        displayName: 'Priya',
        householdLabel: null,
        now: NOW,
      });
      await askWasSent(store, {
        planId: plan.id,
        familyId: priya.familyId,
        userId: priya.userId,
        messageId: `ask-${index}`,
        at: new Date(NOW.getTime() + index * 60_000),
      });
    }
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    let sends = 0;
    const ports = {
      database: db.database,
      now: new Date(NOW.getTime() + 600_000),
      composer: fakeGroupPlanRsvpComposer(),
      consentReader: { read: async () => OK },
      oneToOne: {
        text: async () => {
          sends += 1;
          return { providerMessageId: `priv-${sends}`, chatId: null };
        },
        link: async () => ({ providerMessageId: 'link' }),
      },
    };
    const idOf = (title: string) => planIds.get(title) as string;
    const reply = (text: string, overrides: Partial<typeof ports> = {}) =>
      considerPrivateCalendarReply(
        { ...ports, ...overrides },
        { senderUserId: priya.userId, senderName: 'Priya', chatId: PRIVATE_CHAT, text },
      );
    /** A bare yes the reader places on every title but `left`: Hale asks which of those. */
    const askWhichLeaving = async (left: string | null) => {
      await reply('yes', {
        consentReader: {
          read: async (input: { ask: { title: string } }) =>
            input.ask.title === left ? NOT_THIS : OK,
        },
      } as Partial<typeof ports>);
      expect(
        ports.composer.calls.filter((call) => call.input.kind === 'calendar_which'),
      ).toHaveLength(1);
    };
    const statusOf = async (title: string) =>
      (await store.loadCalendarConsent(idOf(title), priya.familyId))?.status;
    const close = (title: string) =>
      db.database
        .update(schema.linqGroupPlans)
        .set({ closedAt: NOW })
        .where(eq(schema.linqGroupPlans.id, idOf(title)));
    const withdraw = (title: string) =>
      store.releaseCalendarAsk(idOf(title), priya.familyId, priya.userId, 'household_said_no');
    const copies = async () => (await db.database.select().from(schema.familyEvents)).length;
    return { ports, reply, askWhichLeaving, statusOf, close, withdraw, copies };
  }

  it('a stale ask it never named stays untouched when the reply names a closed candidate', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Piano lesson', 'Soccer tournament']);
    await asks.askWhichLeaving('Soccer tournament');
    await asks.close('Soccer practice');
    await asks.reply('yes, soccer practice');
    expect(await asks.statusOf('Soccer tournament')).toBe('asked');
    expect(await asks.statusOf('Piano lesson')).toBe('asked');
    expect(await asks.copies()).toBe(0);
  });

  it('a reply naming the stale ask lands on nothing, not on a candidate sharing its word', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Piano lesson', 'Soccer tournament']);
    await asks.askWhichLeaving('Soccer tournament');
    await asks.reply('yes to the soccer tournament');
    expect(await asks.statusOf('Soccer tournament')).toBe('asked');
    expect(await asks.statusOf('Soccer practice')).toBe('asked');
    expect(await asks.copies()).toBe(0);
  });

  it('with a candidate withdrawn, a word it shared with the other binds nothing', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Soccer tournament']);
    await asks.askWhichLeaving(null);
    expect(await asks.withdraw('Soccer practice')).toBe(true);
    await asks.reply('yes, soccer');
    expect(await asks.statusOf('Soccer tournament')).toBe('asked');
    expect(await asks.copies()).toBe(0);
  });

  it('with two candidates open, a reply naming one by its own word writes that one', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Soccer tournament']);
    await asks.askWhichLeaving(null);
    const named = await asks.reply('yes to the tournament');
    expect(named.handled).toBe(true);
    expect(await asks.statusOf('Soccer tournament')).toBe('written');
    expect(await asks.statusOf('Soccer practice')).toBe('asked');
    expect(await asks.copies()).toBe(1);
  });

  it('a line whose send returned no id has no candidates, so nothing binds', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Piano lesson']);
    await asks.reply('yes', {
      oneToOne: {
        text: async () => ({ providerMessageId: null as unknown as string, chatId: null }),
        link: async () => ({ providerMessageId: 'link' }),
      },
    } as Partial<typeof asks.ports>);
    await asks.reply('yes to the piano');
    expect(await asks.statusOf('Piano lesson')).toBe('asked');
    expect(await asks.statusOf('Soccer practice')).toBe('asked');
    expect(await asks.copies()).toBe(0);
  });

  it('with the calendar flag off, a reply naming a candidate binds nothing', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Piano lesson']);
    await asks.askWhichLeaving(null);
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'false');
    const off = await asks.reply('yes to the piano');
    expect(off.handled).toBe(false);
    expect(await asks.statusOf('Piano lesson')).toBe('asked');
    expect(await asks.copies()).toBe(0);
  });

  it('a line that asked about one plan takes a plain yes for that plan', async () => {
    const asks = await openAsksFor(['Soccer practice', 'Piano lesson']);
    await asks.askWhichLeaving('Soccer practice');
    const yes = await asks.reply('yes');
    expect(yes.handled).toBe(true);
    expect(await asks.statusOf('Piano lesson')).toBe('written');
    expect(await asks.statusOf('Soccer practice')).toBe('asked');
    expect(await asks.copies()).toBe(1);
  });
});

describe('a multi-family chat with no covering family', () => {
  const SHARED = 'chat-multi-plan';

  function startTracking() {
    return {
      intent: 'start_tracking' as const,
      planTitle: 'Riverdale Farm pumpkin walk',
      startsAt: '2026-11-07T14:00:00.000Z',
      location: 'Riverdale Farm',
      deadline: null,
      response: null,
      headcount: 1,
      householdLabel: null,
      coversNames: [] as string[],
      confidence: 'high' as const,
      planKey: 'p1',
      replacesPlanKey: null,
      addressed: false,
    };
  }

  it('opens a plan on the asking household and never writes the other family calendar', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA });
    const sam = await parent({ name: 'Sam', phone: SAM });
    await seatInSharedChat({
      chatId: SHARED,
      familyId: priya.familyId,
      userId: priya.userId,
      phone: PRIYA,
    });
    await seatInSharedChat({
      chatId: SHARED,
      familyId: sam.familyId,
      userId: sam.userId,
      phone: SAM,
    });
    const composer = fakeGroupPlanRsvpComposer();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
    const started = await considerGroupPlanRsvp(
      {
        database: db.database,
        now: NOW,
        composer,
        send: async () => ({ providerMessageId: 'plan-open' }),
        reader: { read: async () => startTracking() },
      },
      {
        chatId: SHARED,
        senderHandle: PRIYA,
        senderUserId: priya.userId,
        text: 'Hale, can you set up a plan for all of us: Riverdale Farm pumpkin walk',
        tapback: null,
      },
    );
    expect(started).toMatchObject({ handled: true, outcome: 'group_plan_spoken' });
    const plans = await db.database
      .select({ familyId: schema.linqGroupPlans.familyId, title: schema.linqGroupPlans.title })
      .from(schema.linqGroupPlans);
    expect(plans).toEqual([{ familyId: priya.familyId, title: 'Riverdale Farm pumpkin walk' }]);
    expect(
      await db.database.select({ id: schema.familyEvents.id }).from(schema.familyEvents),
    ).toEqual([]);

    await considerGroupPlanRsvp(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 60_000),
        composer,
        send: async () => ({ providerMessageId: 'tally' }),
        reader: {
          read: async () => ({
            intent: 'rsvp',
            planTitle: null,
            startsAt: null,
            location: null,
            deadline: null,
            response: 'yes',
            headcount: 1,
            householdLabel: null,
            coversNames: [],
            confidence: 'high',
            planKey: 'p1',
            replacesPlanKey: null,
            addressed: false,
          }),
        },
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne: {
          text: async () => ({ providerMessageId: 'priv-ask', chatId: null }),
          link: async () => ({ providerMessageId: 'link' }),
        },
      },
      {
        chatId: SHARED,
        senderHandle: PRIYA,
        senderUserId: priya.userId,
        text: 'yes, the whole house',
        tapback: null,
      },
    );
    const copies = await db.database
      .select({ familyId: schema.familyEvents.familyId })
      .from(schema.familyEvents);
    expect(copies).toEqual([]);
    const asked = await createPostgresGroupPlanRsvpStore(db.database).listOpenCalendarAsks(
      priya.userId,
    );
    const otherAsks = await createPostgresGroupPlanRsvpStore(db.database).listOpenCalendarAsks(
      sam.userId,
    );
    expect(asked.map((row) => row.consent.familyId)).toEqual([priya.familyId]);
    expect(otherAsks).toEqual([]);
  });

  it('a mixed-family inbound plan ask is not held', async () => {
    const priya = await parent({ name: 'Priya', phone: PRIYA });
    const sam = await parent({ name: 'Sam', phone: SAM });
    await seatInSharedChat({
      chatId: SHARED,
      familyId: priya.familyId,
      userId: priya.userId,
      phone: PRIYA,
    });
    await seatInSharedChat({
      chatId: SHARED,
      familyId: sam.familyId,
      userId: sam.userId,
      phone: SAM,
    });
    const key = Buffer.alloc(32, 9);
    const secret = `whsec_${key.toString('base64')}`;
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', secret);
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
    const body = JSON.stringify({
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_plan',
      created_at: NOW.toISOString(),
      data: {
        chat: {
          id: SHARED,
          is_group: true,
          handles: [
            { handle: PRIYA, is_me: false },
            { handle: SAM, is_me: false },
          ],
        },
        id: 'msg-plan-ask',
        direction: 'inbound',
        sender_handle: { handle: PRIYA, is_me: false },
        parts: [
          {
            type: 'text',
            value: 'Hale, can you set up a plan for all of us: Riverdale Farm pumpkin walk',
          },
        ],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const mac = createHmac('sha256', key).update(`evt_plan.${ts}.${body}`).digest('base64');
    const sent: string[] = [];
    const res = await handleLinqInboundRequest(
      new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'evt_plan',
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
        sendGroupText: async (input) => {
          sent.push(input.text);
          return { providerMessageId: 'plan-open' };
        },
        groupPlanRsvpComposer: fakeGroupPlanRsvpComposer(),
        groupPlanRsvpReader: { read: async () => startTracking() },
      },
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'group_plan_spoken' });
    expect(sent).toHaveLength(1);
    const plans = await db.database
      .select({ familyId: schema.linqGroupPlans.familyId })
      .from(schema.linqGroupPlans);
    expect(plans).toEqual([{ familyId: priya.familyId }]);
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

describe('migration 0225 on a database that already has it', () => {
  it('applies a second time without throwing and keeps the consent table', async () => {
    await db.applyMigration('0225_linq_group_plan_calendar_consent.sql');
    await db.applyMigration('0225_linq_group_plan_calendar_consent.sql');
    const result = await db.client.query(
      "select to_regclass('linq_group_plan_calendar_consents')::text as consents",
    );
    expect(result.rows).toEqual([{ consents: 'linq_group_plan_calendar_consents' }]);
  });
});
