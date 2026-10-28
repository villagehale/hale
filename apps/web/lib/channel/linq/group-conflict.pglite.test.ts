import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { GroupConflictLineInput } from './group-conflict';
import { setGroupConflictWriter } from './group-conflict-voice';
import type {
  GroupPickupClaimReadInput,
  GroupPickupClaimReader,
  GroupPickupClaimReading,
} from './group-pickup-claim';
import { narrateHouseholdCalendar, takeGroupPickupClaim } from './household-calendar';
import { handleLinqInboundRequest } from './inbound';

/**
 * VIL-444 (T24) in the household group: one alert per clash, written by the model, sent
 * once into the group chat with no poll. Covered overlaps, a writer that fails, and quiet
 * hours send nothing. A private plan reaches the writer only as busy. A pickup someone
 * takes in the group is settled and never alerted. Fakes stand in for the model's writer
 * and reader here; the judged eval grades the real ones.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET_BYTES = Buffer.alloc(32, 9);
const HALE = '+14165550100';
const BARTON_PHONE = '+14165550111';
const SAM_PHONE = '+19055550182';
const GROUP = 'chat-clash-group';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
/** 14:00 America/Toronto, two pickups at 15:00. */
const DAY = new Date('2026-09-25T18:00:00.000Z');
const QUIET = new Date('2026-09-25T03:00:00.000Z');
const AT_3 = new Date('2026-09-25T19:00:00.000Z');
const AT_330 = new Date('2026-09-25T19:30:00.000Z');
const AT_4 = new Date('2026-09-25T20:00:00.000Z');
const FAKE_LINE = 'FAKE writer line for the clash';

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
  vi.stubEnv('LINQ_GROUP_CONFLICT_ALERTS_ENABLED', 'true');
});

afterEach(async () => {
  setGroupConflictWriter(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function fakeWriter(text: string | null = FAKE_LINE): { calls: GroupConflictLineInput[] } {
  const calls: GroupConflictLineInput[] = [];
  setGroupConflictWriter({
    async write(input) {
      calls.push(input);
      return text;
    },
  });
  return { calls };
}

function wire(): { fetch: typeof fetch; urls: () => string[]; bodies: () => string } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const note = (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.body) bodies.push(String(init.body));
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      note(url, init);
      return new Response('{}', { status: 500 });
    }),
  );
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    note(url, init);
    return new Response(JSON.stringify({ message: { id: `m-${urls.length}` } }), { status: 200 });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    urls: () => [...urls],
    bodies: () => bodies.join('\n'),
  };
}

async function seedFamily() {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Barton + Sam',
      provinceOrState: 'ON',
      postalCode: 'M5V2T6',
      linqGroupChatId: GROUP,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [barton] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:barton-${familyId}`,
      name: 'Barton Lee',
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const [sam] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:sam-${familyId}`, name: 'Sam', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const bartonId = barton?.id as string;
  const samId = sam?.id as string;
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: bartonId, role: 'primary_parent' },
    { familyId, userId: samId, role: 'co_parent' },
  ]);
  await db.database.insert(schema.parentChannels).values(
    [
      [bartonId, BARTON_PHONE],
      [samId, SAM_PHONE],
    ].map(([userId, phone]) => ({
      userId: userId as string,
      familyId,
      kind: 'sms' as const,
      phoneE164Encrypted: encryptString(phone as string),
      phoneE164Hash: phoneBlindIndex(phone as string),
      verifiedAt: DAY,
    })),
  );
  await db.database.insert(schema.consentRecords).values([
    {
      userId: bartonId,
      familyId,
      consentType: 'proactive_watch',
      granted: true,
      consentScope: WATCH_CONSENT_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'yes please' },
    },
    {
      userId: samId,
      familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_coparent_invite_reply',
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'hi there' },
    },
  ]);
  const kids = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Maya', dateOfBirth: '2022-04-01' },
      { familyId, name: 'Leo', dateOfBirth: '2023-06-01' },
    ])
    .returning({ id: schema.children.id, name: schema.children.name });
  const calendars = await db.database
    .insert(schema.integrations)
    .values([
      {
        familyId,
        userId: bartonId,
        provider: 'gcal' as const,
        status: 'active' as const,
        oauthTokensEncrypted: 'opaque-barton',
      },
      {
        familyId,
        userId: samId,
        provider: 'gcal' as const,
        status: 'active' as const,
        oauthTokensEncrypted: 'opaque-sam',
      },
    ])
    .returning({ id: schema.integrations.id, userId: schema.integrations.userId });
  return {
    familyId,
    bartonId,
    samId,
    mayaId: kids.find((kid) => kid.name === 'Maya')?.id as string,
    bartonCalendar: calendars.find((row) => row.userId === bartonId)?.id as string,
    samCalendar: calendars.find((row) => row.userId === samId)?.id as string,
  };
}

type Seeded = Awaited<ReturnType<typeof seedFamily>>;

async function calendarItem(
  seeded: Seeded,
  who: 'barton' | 'sam',
  item: { eventId: string; title: string | null; start?: Date; end?: Date; announced?: boolean },
) {
  await db.database.insert(schema.parentCalendarBlocks).values({
    integrationId: who === 'barton' ? seeded.bartonCalendar : seeded.samCalendar,
    userId: who === 'barton' ? seeded.bartonId : seeded.samId,
    familyId: seeded.familyId,
    eventId: item.eventId,
    startAt: item.start ?? AT_3,
    endAt: item.end ?? AT_330,
    kidRelated: item.title !== null,
    title: item.title,
    status: 'confirmed',
    updatedStamp: `stamp-${item.eventId}`,
    announcedAt: item.announced ? DAY : null,
  });
}

async function twoPickupsOnBarton(seeded: Seeded, announced = false) {
  await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup', announced });
  await calendarItem(seeded, 'barton', {
    eventId: 'daycare',
    title: 'Leo daycare pickup',
    announced,
  });
}

async function seatCaregiver(seeded: Seeded, name: string, phone: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:${name}-${seeded.familyId}`,
      name,
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId: seeded.familyId,
    chatId: GROUP,
    userId: user?.id as string,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'caregiver',
  });
  return user?.id as string;
}

async function sentRows() {
  return db.database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      channel: schema.channelMessages.channel,
      providerChatId: schema.channelMessages.providerChatId,
      templateKey: schema.channelMessages.templateKey,
      status: schema.channelMessages.status,
    })
    .from(schema.channelMessages);
}

describe('group clash alerts (VIL-444)', () => {
  it('posts one model-written alert into the group for two pickups at once, then stays quiet', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(line.urls()).toEqual([GROUP_MESSAGES]);
    expect(line.bodies()).toContain(FAKE_LINE);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toEqual({
      language: 'en',
      kids: ['Maya', 'Leo'],
      items: [
        {
          kind: 'plan',
          title: 'Leo daycare pickup',
          day: 'Friday, September 25',
          start: '15:00',
          end: '15:30',
          has: 'Barton',
        },
        {
          kind: 'plan',
          title: 'Maya swim pickup',
          day: 'Friday, September 25',
          start: '15:00',
          end: '15:30',
          has: 'Barton',
        },
      ],
      suggested: { name: 'Sam', takes: 'Maya swim pickup' },
      alsoFree: [],
      busy: [],
      couldAsk: [],
    });
    expect(await sentRows()).toEqual([
      {
        parentUserId: seeded.samId,
        channel: 'imessage',
        providerChatId: GROUP,
        templateKey: 'linq:group_clash',
        status: 'sent',
      },
    ]);
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, seeded.familyId));
    expect(audits).toContainEqual({ action: 'calendar_alert_sent', after: { kind: 'clash' } });
    const blocks = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks);
    expect(blocks.every((row) => row.announcedAt !== null)).toBe(true);

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + 15 * 60 * 1000),
      fetch: line.fetch,
    });
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
    expect(writer.calls).toHaveLength(1);
  });

  it('says nothing when two parents cover the overlap', async () => {
    const seeded = await seedFamily();
    await calendarItem(seeded, 'barton', {
      eventId: 'recital',
      title: 'Maya recital',
      end: AT_4,
      announced: true,
    });
    await calendarItem(seeded, 'sam', {
      eventId: 'practice',
      title: 'Leo practice',
      announced: true,
    });
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toEqual([]);
    expect(line.urls()).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('gives the writer a private plan only as busy, and leaves its title out of the group', async () => {
    const seeded = await seedFamily();
    await db.database.insert(schema.familyEvents).values({
      familyId: seeded.familyId,
      childId: seeded.mayaId,
      title: 'Maya allergist',
      startsAt: AT_3,
      endsAt: AT_4,
      source: 'parent',
      sensitive: true,
      dutyOwnerKind: 'parent',
      dutyOwnerUserId: seeded.bartonId,
    });
    await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup' });
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.items[1]).toEqual({ kind: 'busy', who: 'Barton' });
    expect(writer.calls[0]?.suggested).toEqual({ name: 'Sam', takes: 'Maya swim pickup' });
    expect(JSON.stringify(writer.calls)).not.toMatch(/allergist/i);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
    expect(line.bodies()).not.toMatch(/allergist/i);
  });

  it("keeps a teen's plan to busy even when no child is attached to it", async () => {
    const seeded = await seedFamily();
    await db.database
      .insert(schema.children)
      .values({ familyId: seeded.familyId, name: 'Kestrel', dateOfBirth: '2012-01-01' });
    await db.database.insert(schema.familyEvents).values({
      familyId: seeded.familyId,
      title: 'Kestrel orthodontist',
      startsAt: AT_3,
      endsAt: AT_4,
      source: 'parent',
      dutyOwnerKind: 'parent',
      dutyOwnerUserId: seeded.bartonId,
    });
    await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup' });
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.items[1]).toEqual({ kind: 'busy', who: 'Barton' });
    expect(writer.calls[0]?.kids).toEqual(['Maya', 'Leo']);
    expect(JSON.stringify(writer.calls)).not.toMatch(/kestrel|orthodontist/i);
  });

  it("keeps a private plan's calendar copy to busy after the parent drags it to another day", async () => {
    const seeded = await seedFamily();
    const lastWeek = new Date(AT_3.getTime() - 7 * 24 * 60 * 60 * 1000);
    await db.database.insert(schema.familyEvents).values({
      familyId: seeded.familyId,
      childId: seeded.mayaId,
      title: 'Maya allergist',
      startsAt: lastWeek,
      endsAt: new Date(lastWeek.getTime() + 60 * 60 * 1000),
      source: 'parent',
      sensitive: true,
      placedGoogleEventId: 'placed-allergist',
      placedGoogleIntegrationId: seeded.bartonCalendar,
    });
    await calendarItem(seeded, 'barton', {
      eventId: 'placed-allergist',
      title: 'Maya allergist',
      end: AT_4,
    });
    await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup' });
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.items[1]).toEqual({ kind: 'busy', who: 'Barton' });
    expect(JSON.stringify(writer.calls)).not.toMatch(/allergist/i);
    expect(line.bodies()).not.toMatch(/allergist/i);
  });

  it('sends nothing and claims no row when the model cannot write the alert', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const writer = fakeWriter(null);
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([]);
    expect(await sentRows()).toEqual([]);
    const blocks = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks);
    expect(blocks.every((row) => row.announcedAt === null)).toBe(true);
  });

  it('asks a caregiver with no calendar, and never calls them free', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    await calendarItem(seeded, 'sam', { eventId: 'work', title: null, end: AT_4 });
    await seatCaregiver(seeded, 'Rosa', '+14165550199');
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toMatchObject({
      suggested: null,
      alsoFree: [],
      busy: ['Sam'],
      couldAsk: ['Rosa'],
    });
    expect(await sentRows()).toEqual([
      expect.objectContaining({ parentUserId: seeded.bartonId, templateKey: 'linq:group_clash' }),
    ]);
  });

  it('holds the alert in quiet hours before paying the model, and sends it in the day', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: QUIET,
      fetch: line.fetch,
    });
    expect(writer.calls).toEqual([]);
    expect(line.urls()).toEqual([]);

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
  });

  it('never asks the writer while the flag is off', async () => {
    vi.stubEnv('LINQ_GROUP_CONFLICT_ALERTS_ENABLED', 'yes');
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const writer = fakeWriter();
    const line = wire();

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });

    expect(writer.calls).toEqual([]);
    expect((await sentRows()).some((row) => row.templateKey === 'linq:group_clash')).toBe(false);
  });
});

const MINUTE = 60 * 1000;

function fakeClaimReader(
  answer: (input: GroupPickupClaimReadInput) => GroupPickupClaimReading | null,
): GroupPickupClaimReader & { calls: GroupPickupClaimReadInput[] } {
  const calls: GroupPickupClaimReadInput[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      return answer(input);
    },
  };
}

/** A reading of the plan offered under this title, as the model would return it. */
function reads(
  title: string,
  intent: GroupPickupClaimReading['intent'] = 'claim_pickup',
): (input: GroupPickupClaimReadInput) => GroupPickupClaimReading {
  return (input) => ({
    intent,
    pickupRefs: [input.pickups.find((offer) => offer.title === title)?.ref ?? 'not-offered'],
    confidence: 'high',
  });
}

function claim(
  seeded: Seeded,
  senderUserId: string,
  reader: GroupPickupClaimReader,
  over: { text?: string; now?: Date; chatId?: string } = {},
) {
  return takeGroupPickupClaim(
    db.database,
    {
      familyId: seeded.familyId,
      chatId: over.chatId ?? GROUP,
      senderUserId,
      text: over.text ?? 'got it',
      now: over.now ?? DAY,
    },
    { reader },
  );
}

/** The live who-takes decisions: who has each, from what, and since when. */
async function liveTakers(familyId: string) {
  const rows = await db.database
    .select({
      factValue: schema.familyMemoryFacts.factValue,
      validFrom: schema.familyMemoryFacts.validFrom,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
  return rows
    .filter((row) => row.validUntil === null)
    .map((row) => {
      const value = row.factValue as { takerUserId: string | null; source: string };
      return { takerUserId: value.takerUserId, source: value.source, since: row.validFrom };
    });
}

async function whoTakesFacts(familyId: string) {
  return db.database
    .select({
      factValue: schema.familyMemoryFacts.factValue,
      inferredBy: schema.familyMemoryFacts.inferredBy,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

async function familyAudits(familyId: string) {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      action: schema.auditLog.actionTaken,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

function signed(body: unknown): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(DAY.getTime() / 1000));
  const mac = createHmac('sha256', SECRET_BYTES).update(`evt_claim.${ts}.${raw}`).digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_claim',
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function groupMessage(from: string, text: string, messageId: string) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: 'evt_claim',
    created_at: DAY.toISOString(),
    data: {
      chat: { id: GROUP, is_group: true },
      id: messageId,
      direction: 'inbound',
      sender_handle: { handle: from, is_me: false },
      parts: [{ type: 'text', value: text }],
      sent_at: DAY.toISOString(),
      service: 'iMessage',
    },
  };
}

describe('group pickup claims (VIL-444)', () => {
  it('settles a pickup someone takes before any alert, so its clash is never sent', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded, true);
    const reader = fakeClaimReader(reads('Leo daycare pickup'));

    expect(await claim(seeded, seeded.samId, reader, { text: "I'll grab Leo from daycare" })).toBe(
      'claimed',
    );

    expect(reader.calls).toEqual([
      {
        text: "I'll grab Leo from daycare",
        senderName: 'Sam',
        recent: [],
        pickups: [
          {
            ref: 'p1',
            title: 'Leo daycare pickup',
            day: 'Friday, September 25',
            start: '15:00',
            end: '15:30',
            has: 'Barton',
            inAlert: false,
            askedOf: null,
          },
          {
            ref: 'p2',
            title: 'Maya swim pickup',
            day: 'Friday, September 25',
            start: '15:00',
            end: '15:30',
            has: 'Barton',
            inAlert: false,
            askedOf: null,
          },
        ],
      },
    ]);
    expect(await whoTakesFacts(seeded.familyId)).toEqual([
      {
        factValue: expect.objectContaining({
          kind: 'who_takes',
          status: 'decided',
          startIso: AT_3.toISOString(),
          titleNorm: 'leo daycare pickup',
          takerUserId: seeded.samId,
          source: 'claim',
        }),
        inferredBy: 'linq_pickup_claim',
        validUntil: null,
      },
    ]);
    expect(await familyAudits(seeded.familyId)).toContainEqual({
      actor: seeded.samId,
      action: 'logistics_decision_recorded',
      after: { kind: 'who_takes', status: 'decided', source: 'claim' },
    });

    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toEqual([]);
    expect(line.urls()).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('after an alert, a pickup someone takes is settled and the group hears nothing more', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.suggested).toEqual({ name: 'Sam', takes: 'Maya swim pickup' });

    const later = new Date(DAY.getTime() + 5 * MINUTE);
    const keeps = fakeClaimReader(reads('Maya swim pickup'));
    expect(await claim(seeded, seeded.bartonId, keeps, { text: "I'll do swim", now: later })).toBe(
      'claimed',
    );
    expect(keeps.calls[0]?.pickups).toEqual([
      expect.objectContaining({ title: 'Leo daycare pickup', inAlert: true, askedOf: null }),
      expect.objectContaining({ title: 'Maya swim pickup', inAlert: true, askedOf: 'Sam' }),
    ]);
    expect(await claim(seeded, seeded.bartonId, keeps, { now: later })).toBe('already_claimed');

    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + 15 * MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);

    const takes = fakeClaimReader(reads('Leo daycare pickup'));
    expect(await claim(seeded, seeded.samId, takes, { now: later })).toBe('claimed');
    expect(takes.calls[0]?.pickups).toEqual([
      expect.objectContaining({ title: 'Leo daycare pickup', has: 'Barton', inAlert: true }),
      expect.objectContaining({ title: 'Maya swim pickup', has: 'Barton', inAlert: false }),
    ]);
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + 30 * MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
  });

  it('changes nothing for chatter, a low or failed read, or a plan that was not offered', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const readings: Array<GroupPickupClaimReading | null> = [
      { intent: 'chatter', pickupRefs: [], confidence: 'high' },
      { intent: 'claim_pickup', pickupRefs: ['p1'], confidence: 'low' },
      null,
      { intent: 'claim_pickup', pickupRefs: ['p1', 'p7'], confidence: 'high' },
    ];
    const outcomes: string[] = [];
    for (const reading of readings) {
      outcomes.push(
        await claim(
          seeded,
          seeded.samId,
          fakeClaimReader(() => reading),
        ),
      );
    }
    expect(outcomes).toEqual(['not_a_claim', 'not_a_claim', 'unread', 'not_a_claim']);
    expect(await whoTakesFacts(seeded.familyId)).toEqual([]);

    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: DAY,
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
  });

  it('lets only the taker give a pickup back, and then the clash is alerted after all', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded);
    const daycare = (intent: GroupPickupClaimReading['intent']) =>
      fakeClaimReader(reads('Leo daycare pickup', intent));
    expect(await claim(seeded, seeded.samId, daycare('claim_pickup'))).toBe('claimed');
    expect(await claim(seeded, seeded.bartonId, daycare('drop_pickup'))).toBe('nothing_to_drop');

    const later = new Date(DAY.getTime() + MINUTE);
    expect(await claim(seeded, seeded.samId, daycare('drop_pickup'), { now: later })).toBe(
      'dropped',
    );
    expect(await whoTakesFacts(seeded.familyId)).toEqual([
      expect.objectContaining({ validUntil: later }),
    ]);
    expect(await familyAudits(seeded.familyId)).toContainEqual({
      actor: seeded.samId,
      action: 'logistics_decision_withheld',
      after: { kind: 'who_takes', stored: false, source: 'claim' },
    });

    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + 2 * MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(line.urls()).toEqual([GROUP_MESSAGES]);
  });

  it("never offers the reader a private plan, a teen's plan or one under way", async () => {
    const seeded = await seedFamily();
    await db.database
      .insert(schema.children)
      .values({ familyId: seeded.familyId, name: 'Kestrel', dateOfBirth: '2012-01-01' });
    await db.database.insert(schema.familyEvents).values([
      {
        familyId: seeded.familyId,
        childId: seeded.mayaId,
        title: 'Maya allergist',
        startsAt: AT_3,
        endsAt: AT_4,
        source: 'parent',
        sensitive: true,
        dutyOwnerKind: 'parent',
        dutyOwnerUserId: seeded.bartonId,
      },
      {
        familyId: seeded.familyId,
        title: 'Kestrel orthodontist',
        startsAt: AT_330,
        endsAt: AT_4,
        source: 'parent',
      },
    ]);
    await calendarItem(seeded, 'sam', {
      eventId: 'swim',
      title: 'Maya swim pickup',
      announced: true,
    });
    await calendarItem(seeded, 'sam', {
      eventId: 'nap',
      title: 'Leo nap pickup',
      start: new Date(DAY.getTime() - 30 * MINUTE),
      end: new Date(DAY.getTime() + 30 * MINUTE),
      announced: true,
    });
    const reader = fakeClaimReader(() => ({
      intent: 'claim_pickup',
      pickupRefs: ['p1'],
      confidence: 'high',
    }));

    expect(await claim(seeded, seeded.bartonId, reader, { text: 'I can do all of them' })).toBe(
      'claimed',
    );

    expect(reader.calls[0]?.pickups.map((offer) => offer.title)).toEqual(['Maya swim pickup']);
    expect(JSON.stringify(reader.calls[0]?.pickups)).not.toMatch(/allergist|kestrel|orthodont/i);
    expect(
      (await whoTakesFacts(seeded.familyId)).map(
        (row) => (row.factValue as { titleNorm: string }).titleNorm,
      ),
    ).toEqual(['maya swim pickup']);
  });

  it('lets a caregiver seated in the chat take a pickup, and nobody outside it', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded, true);
    const rosa = await seatCaregiver(seeded, 'Rosa', '+14165550199');
    const [outsider] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:jo-${seeded.familyId}`, name: 'Jo', timezone: 'UTC' })
      .returning({ id: schema.users.id });
    const ignored = fakeClaimReader(reads('Leo daycare pickup'));
    expect(await claim(seeded, outsider?.id as string, ignored)).toBe('not_a_member');
    expect(ignored.calls).toEqual([]);

    const reader = fakeClaimReader(reads('Leo daycare pickup'));
    expect(await claim(seeded, rosa, reader, { text: 'I can get Leo, no problem' })).toBe(
      'claimed',
    );
    expect(reader.calls[0]?.senderName).toBe('Rosa');

    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toEqual([]);
    expect(line.urls()).toEqual([]);
  });

  it('lets a claim outrank a duty owner set before it, and a duty owner set after it win', async () => {
    const seeded = await seedFamily();
    const [piano] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: seeded.familyId,
        title: 'Leo piano pickup',
        startsAt: AT_3,
        endsAt: AT_330,
        source: 'parent',
        dutyOwnerKind: 'parent',
        dutyOwnerUserId: seeded.bartonId,
        dutySetAt: new Date(DAY.getTime() - 60 * MINUTE),
      })
      .returning({ id: schema.familyEvents.id });
    await calendarItem(seeded, 'barton', { eventId: 'work', title: null, end: AT_4 });

    expect(await claim(seeded, seeded.samId, fakeClaimReader(reads('Leo piano pickup')))).toBe(
      'claimed',
    );
    const writer = fakeWriter();
    const line = wire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toEqual([]);

    await db.database
      .update(schema.familyEvents)
      .set({ dutySetAt: new Date(DAY.getTime() + 2 * MINUTE) })
      .where(eq(schema.familyEvents.id, piano?.id as string));
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + 3 * MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.items).toEqual([
      expect.objectContaining({ kind: 'plan', title: 'Leo piano pickup', has: 'Barton' }),
      { kind: 'busy', who: 'Barton' },
    ]);
  });

  it('reads nothing while the flag is off, or for a chat that is not the household group', async () => {
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded, true);
    const reader = fakeClaimReader(reads('Leo daycare pickup'));

    expect(await claim(seeded, seeded.samId, reader, { chatId: 'chat-elsewhere' })).toBe(
      'not_household_group',
    );
    vi.stubEnv('LINQ_GROUP_CONFLICT_ALERTS_ENABLED', 'yes');
    expect(await claim(seeded, seeded.samId, reader)).toBe('flag_off');

    expect(reader.calls).toEqual([]);
    expect(await whoTakesFacts(seeded.familyId)).toEqual([]);
  });

  it('reads a claim at the group door, and the alert for that slot never goes', async () => {
    vi.stubEnv('LINQ_FROM_E164', HALE);
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const seeded = await seedFamily();
    await twoPickupsOnBarton(seeded, true);
    const line = wire();
    const reader = fakeClaimReader(reads('Leo daycare pickup'));
    const sends: string[] = [];
    const deps = {
      database: db.database,
      enqueue: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      now: () => DAY,
      listChatHandles: async () => ({
        status: 'ok',
        handles: [BARTON_PHONE, SAM_PHONE],
        isGroup: true,
      }),
      sendGroupText: async (input: { text: string }) => {
        sends.push(input.text);
        return { providerMessageId: `out-${sends.length}` };
      },
      groupPickupClaimReader: reader,
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];

    const response = await handleLinqInboundRequest(
      signed(groupMessage(SAM_PHONE, "I'll grab Leo from daycare", 'in-claim')),
      deps,
    );

    expect(await response.json()).toEqual({ outcome: 'group_duty_statement' });
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]).toMatchObject({
      text: "I'll grab Leo from daycare",
      senderName: 'Sam',
    });
    expect(await whoTakesFacts(seeded.familyId)).toEqual([
      expect.objectContaining({
        factValue: expect.objectContaining({ takerUserId: seeded.samId, source: 'claim' }),
      }),
    ]);
    expect(sends).toEqual([]);

    const writer = fakeWriter();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(DAY.getTime() + MINUTE),
      fetch: line.fetch,
    });
    expect(writer.calls).toEqual([]);
    expect(await sentRows()).toEqual([]);
  });

  it('takes nothing when the plan it names shares its decision with one it left out', async () => {
    const seeded = await seedFamily();
    await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup' });
    await calendarItem(seeded, 'barton', {
      eventId: 'swim-long',
      title: 'Maya swim pickup',
      end: AT_4,
    });
    const ending = (...ends: string[]) =>
      fakeClaimReader((input) => ({
        intent: 'claim_pickup',
        pickupRefs: input.pickups
          .filter((offer) => ends.includes(offer.end))
          .map((offer) => offer.ref),
        confidence: 'high',
      }));

    expect(await claim(seeded, seeded.samId, ending('15:30'))).toBe('not_a_claim');
    expect(await whoTakesFacts(seeded.familyId)).toEqual([]);
    expect(await claim(seeded, seeded.samId, ending('15:30', '16:00'))).toBe('claimed');
    expect(await liveTakers(seeded.familyId)).toEqual([
      { takerUserId: seeded.samId, source: 'claim', since: DAY },
    ]);
  });
});
