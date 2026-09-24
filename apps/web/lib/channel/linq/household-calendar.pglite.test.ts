import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { listActiveConnectorConnections } from '~/lib/integrations/store';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { groupKidEventText } from './group-coparent-copy';
import {
  familyHasTwoCalendars,
  formatDay,
  formatTime,
  narrateHouseholdCalendar,
  narrateHouseholdMailbox,
  rememberAndNarrateCalendar,
  rememberCalendarChanges,
} from './household-calendar';

/**
 * Both calendars in one family. Kid news may be said in the group. A non-kid
 * title is not stored and cannot be sent. Quiet hours and a second pass do
 * not send again.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19059629821';
const GROUP = 'chat-household-group';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const QUIET = new Date('2026-09-25T03:00:00.000Z');
const DAY = new Date('2026-09-25T18:00:00.000Z');
/** 17:30 America/Toronto — inside the evening handoff window, outside quiet hours. */
const HANDOFF_AT = new Date('2026-09-24T21:30:00.000Z');

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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function groupWire(over?: { status?: number }): {
  fetch: typeof fetch;
  linqUrls: () => string[];
  twilioUrls: () => string[];
  bodies: () => string;
} {
  const linqUrls: string[] = [];
  const twilioUrls: string[] = [];
  const bodies: string[] = [];
  const note = (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('twilio.com')) twilioUrls.push(target);
    else linqUrls.push(target);
    if (init?.body) bodies.push(String(init.body));
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      note(url, init);
      return new Response('{}', { status: 500 });
    }),
  );
  const status = over?.status ?? 200;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    note(url, init);
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: status } }), { status });
    }
    return new Response(JSON.stringify({ message: { id: `m-${linqUrls.length}` } }), {
      status: 200,
    });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    linqUrls: () => [...linqUrls],
    twilioUrls: () => [...twilioUrls],
    bodies: () => bodies.join('\n'),
  };
}

function stubTwilioConfigured(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'auth-token');
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'api-key-secret');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');
}

function linqFetch(): { fetch: typeof fetch; texts: () => string } {
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ message: { id: `m-${bodies.length}` } }), {
      status: 200,
    });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: () => JSON.stringify(bodies),
  };
}

function change(
  over: Partial<CalendarChange> & Pick<CalendarChange, 'eventId' | 'title'>,
): CalendarChange {
  return {
    updated: 'stamp-1',
    status: 'confirmed',
    start: { dateTime: '2026-09-25T19:00:00.000Z' },
    end: { dateTime: '2026-09-25T20:00:00.000Z' },
    ...over,
  };
}

async function seedPair(): Promise<{
  familyId: string;
  primaryUserId: string;
  coparentUserId: string;
  primaryIntegrationId: string;
  coparentIntegrationId: string;
}> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Barton + kids',
      provinceOrState: 'ON',
      postalCode: 'M5V2T6',
      linqGroupChatId: GROUP,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [primary] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:primary-${familyId}`,
      name: 'Barton',
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
  await db.database.insert(schema.parentChannels).values([
    {
      userId: primaryUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PARENT_PHONE),
      phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
      verifiedAt: DAY,
    },
    {
      userId: coparentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(COPARENT_PHONE),
      phoneE164Hash: phoneBlindIndex(COPARENT_PHONE),
      verifiedAt: DAY,
    },
  ]);
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
  await db.database.insert(schema.children).values({
    familyId,
    name: 'Maya',
    dateOfBirth: '2022-04-01',
  });
  const [primaryIntegration] = await db.database
    .insert(schema.integrations)
    .values({
      familyId,
      userId: primaryUserId,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: 'opaque-primary',
    })
    .returning({ id: schema.integrations.id });
  const [coparentIntegration] = await db.database
    .insert(schema.integrations)
    .values({
      familyId,
      userId: coparentUserId,
      provider: 'gcal',
      status: 'active',
      oauthTokensEncrypted: 'opaque-coparent',
    })
    .returning({ id: schema.integrations.id });
  return {
    familyId,
    primaryUserId,
    coparentUserId,
    primaryIntegrationId: primaryIntegration?.id as string,
    coparentIntegrationId: coparentIntegration?.id as string,
  };
}

describe('household calendars', () => {
  it('holds two Google calendars on one family', async () => {
    const seeded = await seedPair();
    expect(await familyHasTwoCalendars(db.database, seeded.familyId)).toBe(true);
    const listed = await listActiveConnectorConnections(db.database);
    const mine = listed.filter(
      (row) => row.familyId === seeded.familyId && row.provider === 'gcal',
    );
    expect(mine.map((row) => row.userId).sort()).toEqual(
      [seeded.primaryUserId, seeded.coparentUserId].sort(),
    );
  });

  it('stores a non-kid event with no title, and the check rejects one that has a title', async () => {
    const seeded = await seedPair();
    await rememberCalendarChanges(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'budget', title: 'Quarterly budget review' })],
      childNames: ['Maya'],
      seeding: false,
      bothCalendars: true,
      now: DAY,
    });
    const [row] = await db.database
      .select({
        title: schema.parentCalendarBlocks.title,
        kidRelated: schema.parentCalendarBlocks.kidRelated,
      })
      .from(schema.parentCalendarBlocks);
    expect(row).toEqual({ title: null, kidRelated: false });
    await expect(
      db.database.insert(schema.parentCalendarBlocks).values({
        integrationId: seeded.primaryIntegrationId,
        eventId: 'leak',
        familyId: seeded.familyId,
        userId: seeded.primaryUserId,
        kidRelated: false,
        title: 'Quarterly budget review',
        status: 'confirmed',
        updatedStamp: 'stamp-leak',
      }),
    ).rejects.toThrow();
  });

  it('does not narrate a seeding run', async () => {
    const seeded = await seedPair();
    const wire = linqFetch();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: true,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.texts()).toBe('[]');
    const [row] = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks);
    expect(row?.announcedAt).not.toBeNull();
  });

  it('tells the group about a kid event once, and holds the same news in quiet hours', async () => {
    const seeded = await seedPair();
    const wire = linqFetch();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [
        change({ eventId: 'gym', title: 'Maya gymnastics' }),
        change({ eventId: 'budget', title: 'Quarterly budget review' }),
      ],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.texts()).toContain('Heads up:');
    expect(wire.texts()).toContain('gymnastics');
    expect(wire.texts()).not.toContain('Quarterly');
    expect(wire.texts()).not.toContain('budget');
    const afterFirst = wire.texts();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.texts()).toBe(afterFirst);

    await db.exec('truncate table families, users cascade');
    const quietHouse = await seedPair();
    const quietWire = linqFetch();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: quietHouse.primaryIntegrationId,
      familyId: quietHouse.familyId,
      userId: quietHouse.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: QUIET,
      fetch: quietWire.fetch,
    });
    expect(quietWire.texts()).toBe('[]');
    const [held] = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks)
      .where(eq(schema.parentCalendarBlocks.eventId, 'gym'));
    expect(held?.announcedAt).toBeNull();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: quietHouse.primaryIntegrationId,
      familyId: quietHouse.familyId,
      userId: quietHouse.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: quietWire.fetch,
    });
    expect(quietWire.texts()).toContain('Heads up:');
    expect(quietWire.texts()).toContain('gymnastics');
  });

  it('keeps mailbox subjects, senders, and bodies out of the group', async () => {
    const seeded = await seedPair();
    await db.database.insert(schema.integrations).values([
      {
        familyId: seeded.familyId,
        userId: seeded.primaryUserId,
        provider: 'gmail',
        status: 'active',
        oauthTokensEncrypted: 'opaque-gmail-a',
      },
      {
        familyId: seeded.familyId,
        userId: seeded.coparentUserId,
        provider: 'gmail',
        status: 'active',
        oauthTokensEncrypted: 'opaque-gmail-b',
      },
    ]);
    const wire = linqFetch();
    const subject = 'Gymnastics registration closes Friday';
    const sender = 'office@camp-secret.test';
    const body = 'Please reply with Maya snack preferences and the waiver.';
    const suppressed = await narrateHouseholdMailbox(db.database, {
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      envelopes: [
        { messageId: 'mail-gym', subject, from: sender, body },
        { messageId: 'mail-budget', subject: 'Quarterly budget review', from: 'cfo@work.test' },
        { messageId: 'mail-from', subject: 'Maya <coach@gym.test>', body: 'See you at the gym.' },
      ],
      now: DAY,
      fetch: wire.fetch,
    });
    expect(suppressed).toEqual({ suppressed: 'mail_not_in_group' });
    expect(wire.texts()).toBe('[]');

    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    const when = new Date('2026-09-25T19:00:00.000Z');
    const notice = groupKidEventText('en', {
      name: 'Barton',
      kid: 'Maya',
      event: 'gymnastics',
      day: formatDay(when, 'America/Toronto', 'en'),
      time: formatTime(when, 'America/Toronto', 'en'),
    });
    expect(wire.texts()).toContain(notice);
    for (const secret of [subject, sender, body, 'Quarterly budget', 'coach@gym.test', 'snack']) {
      expect(wire.texts()).not.toContain(secret);
    }
  });

  it('sends at most one group bubble a day', async () => {
    const seeded = await seedPair();
    const wire = linqFetch();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.texts()).toContain('Heads up:');
    const afterFirst = wire.texts();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [
        change({
          eventId: 'swim',
          title: 'Maya swim',
          start: { dateTime: '2026-09-26T19:00:00.000Z' },
          end: { dateTime: '2026-09-26T20:00:00.000Z' },
        }),
      ],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.texts()).toBe(afterFirst);
    const [held] = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks)
      .where(eq(schema.parentCalendarBlocks.eventId, 'swim'));
    expect(held?.announcedAt).toBeNull();
  });

  it('sends kid-event, conflict, handoff, and post-event only to the Linq group chat', async () => {
    stubTwilioConfigured();
    const start = new Date('2026-09-25T19:00:00.000Z');
    const end = new Date('2026-09-25T20:00:00.000Z');

    const kid = await seedPair();
    const kidWire = groupWire();
    await rememberAndNarrateCalendar(db.database, {
      integrationId: kid.primaryIntegrationId,
      familyId: kid.familyId,
      userId: kid.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: kidWire.fetch,
    });
    expect(kidWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(kidWire.twilioUrls()).toEqual([]);
    expect(kidWire.bodies()).toContain('Heads up:');

    await db.exec('truncate table families, users cascade');
    const conflict = await seedPair();
    await db.database.insert(schema.parentCalendarBlocks).values([
      {
        integrationId: conflict.primaryIntegrationId,
        eventId: 'gym',
        familyId: conflict.familyId,
        userId: conflict.primaryUserId,
        startAt: start,
        endAt: end,
        kidRelated: true,
        title: 'Maya gymnastics',
        status: 'confirmed',
        updatedStamp: 'stamp-gym',
      },
      {
        integrationId: conflict.coparentIntegrationId,
        eventId: 'busy',
        familyId: conflict.familyId,
        userId: conflict.coparentUserId,
        startAt: start,
        endAt: end,
        kidRelated: false,
        title: null,
        status: 'confirmed',
        updatedStamp: 'stamp-busy',
      },
    ]);
    const conflictWire = groupWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: conflict.familyId,
      now: DAY,
      fetch: conflictWire.fetch,
    });
    expect(conflictWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(conflictWire.twilioUrls()).toEqual([]);
    expect(conflictWire.bodies()).toContain("Who's taking it?");

    await db.exec('truncate table families, users cascade');
    const handoff = await seedPair();
    const tomorrow = new Date('2026-09-25T19:00:00.000Z');
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId: handoff.primaryIntegrationId,
      eventId: 'gym',
      familyId: handoff.familyId,
      userId: handoff.primaryUserId,
      startAt: tomorrow,
      endAt: new Date('2026-09-25T20:00:00.000Z'),
      kidRelated: true,
      title: 'Maya gymnastics',
      status: 'confirmed',
      updatedStamp: 'stamp-handoff',
    });
    const handoffWire = groupWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: handoff.familyId,
      now: HANDOFF_AT,
      fetch: handoffWire.fetch,
    });
    expect(handoffWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(handoffWire.twilioUrls()).toEqual([]);
    expect(handoffWire.bodies()).toContain('Tomorrow:');

    await db.exec('truncate table families, users cascade');
    const followup = await seedPair();
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId: followup.primaryIntegrationId,
      eventId: 'gym',
      familyId: followup.familyId,
      userId: followup.primaryUserId,
      startAt: new Date(DAY.getTime() - 2 * 60 * 60 * 1000),
      endAt: new Date(DAY.getTime() - 60 * 60 * 1000),
      kidRelated: true,
      title: 'Maya gymnastics',
      status: 'confirmed',
      updatedStamp: 'stamp-followup',
      announcedAt: new Date(DAY.getTime() - 3 * 60 * 60 * 1000),
    });
    const followupWire = groupWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: followup.familyId,
      now: DAY,
      fetch: followupWire.fetch,
    });
    expect(followupWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(followupWire.twilioUrls()).toEqual([]);
    expect(followupWire.bodies()).toContain('how did gymnastics go?');

    const rows = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
        templateKey: schema.channelMessages.templateKey,
        status: schema.channelMessages.status,
      })
      .from(schema.channelMessages);
    expect(rows).toEqual([
      expect.objectContaining({
        channel: 'imessage',
        providerChatId: GROUP,
        templateKey: 'linq:group_followup',
        status: 'sent',
      }),
    ]);
    expect(rows.some((row) => row.channel === 'sms')).toBe(false);
  });

  it('does not fall back to Twilio when the group notice is refused', async () => {
    stubTwilioConfigured();
    const seeded = await seedPair();
    const wire = groupWire({ status: 500 });
    await rememberAndNarrateCalendar(db.database, {
      integrationId: seeded.primaryIntegrationId,
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      changes: [change({ eventId: 'gym', title: 'Maya gymnastics' })],
      seeding: false,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(wire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(wire.twilioUrls()).toEqual([]);
    const rows = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
        status: schema.channelMessages.status,
      })
      .from(schema.channelMessages);
    expect(rows).toEqual([{ channel: 'imessage', providerChatId: GROUP, status: 'failed' }]);
    const [block] = await db.database
      .select({ announcedAt: schema.parentCalendarBlocks.announcedAt })
      .from(schema.parentCalendarBlocks);
    expect(block?.announcedAt).toBeNull();
  });
});
