import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { postgresGroupPlanCalendarWriter, postgresGroupPlanHouseholds } from './calendar';
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

async function parent(input: { name: string; phone: string; chat?: string }) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: input.name,
      provinceOrState: 'ON',
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
    expect(await homes.resolve({ chatId: CHAT, userId: priya.userId })).toEqual({
      status: 'one',
      familyId: priya.familyId,
    });
    expect(await homes.resolve({ chatId: CHAT, userId: sam.userId })).toEqual({
      status: 'one',
      familyId: sam.familyId,
    });
    expect(await homes.resolve({ chatId: CHAT, userId: null })).toEqual({ status: 'none' });

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
    const send = async () => ({ providerMessageId: 'm' });
    const base = {
      store,
      composer: fakeGroupPlanRsvpComposer(),
      send,
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

    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: priya.userId,
        text: 'yes put it on our calendar',
        tapback: null,
        language: 'en',
        now: new Date(NOW.getTime() + 60_000),
      },
      base,
    );

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
  });
});
