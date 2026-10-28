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
import { narrateHouseholdCalendar } from './household-calendar';

/**
 * VIL-444 (T24) in the household group: one alert per clash, written by the model, sent
 * once into the group chat with no poll. Covered overlaps, a writer that fails, and quiet
 * hours send nothing. A private plan reaches the writer only as busy. A fake writer
 * stands in for the model here; the judged eval grades the real one.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
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
      [bartonId, '+14165550111'],
      [samId, '+19055550182'],
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

async function twoPickupsOnBarton(seeded: Seeded) {
  await calendarItem(seeded, 'barton', { eventId: 'swim', title: 'Maya swim pickup' });
  await calendarItem(seeded, 'barton', { eventId: 'daycare', title: 'Leo daycare pickup' });
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
    const [rosa] = await db.database
      .insert(schema.users)
      .values({
        externalAuthId: `sms:rosa-${seeded.familyId}`,
        name: 'Rosa',
        timezone: 'America/Toronto',
      })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: seeded.familyId,
      chatId: GROUP,
      userId: rosa?.id as string,
      phoneE164Encrypted: encryptString('+14165550199'),
      phoneE164Hash: phoneBlindIndex('+14165550199'),
      role: 'caregiver',
    });
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
