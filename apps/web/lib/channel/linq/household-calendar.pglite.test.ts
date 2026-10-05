import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { listActiveConnectorConnections } from '~/lib/integrations/store';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { type GroupVoice, groupLineInput } from './group-voice';
import {
  captureLogisticsText,
  familyHasTwoCalendars,
  formatDay,
  formatTime,
  narrateHouseholdCalendar,
  narrateHouseholdMailbox,
  rememberAndNarrateCalendar,
  rememberCalendarChanges,
} from './household-calendar';
import { recordLogisticsVote } from './logistics-poll';

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
  voice: GroupVoice;
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
    voice: fakeSpokenLineComposer(),
  };
}

function stubTwilioConfigured(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'auth-token');
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'api-key-secret');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');
}

function linqFetch(): { fetch: typeof fetch; texts: () => string; voice: GroupVoice } {
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
    voice: fakeSpokenLineComposer(),
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
      voice: wire.voice,
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
      voice: wire.voice,
    });
    expect(wire.texts()).toContain('kid_event:');
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
      voice: wire.voice,
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
      voice: quietWire.voice,
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
      voice: quietWire.voice,
    });
    expect(quietWire.texts()).toContain('kid_event:');
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
      voice: wire.voice,
    });
    const when = new Date('2026-09-25T19:00:00.000Z');
    const notice = fakeSpokenLineBody(
      groupLineInput(
        {
          kind: 'kid_event',
          events: [
            {
              parent: 'Barton',
              kid: 'Maya',
              event: 'gymnastics',
              day: formatDay(when, 'America/Toronto', 'en'),
              time: formatTime(when, 'America/Toronto', 'en'),
            },
          ],
        },
        'en',
      ),
    );
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
      voice: wire.voice,
    });
    expect(wire.texts()).toContain('kid_event:');
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
      voice: wire.voice,
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
      voice: kidWire.voice,
    });
    expect(kidWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(kidWire.twilioUrls()).toEqual([]);
    expect(kidWire.bodies()).toContain('kid_event:');

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
      voice: conflictWire.voice,
    });
    expect(conflictWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(conflictWire.twilioUrls()).toEqual([]);
    expect(conflictWire.bodies()).toContain('conflict:');

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
      voice: handoffWire.voice,
    });
    expect(handoffWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(handoffWire.twilioUrls()).toEqual([]);
    expect(handoffWire.bodies()).toContain('handoff:');

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
      voice: followupWire.voice,
    });
    expect(followupWire.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(followupWire.twilioUrls()).toEqual([]);
    expect(followupWire.bodies()).toContain('how_it_went:');

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
      voice: wire.voice,
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

  it('posts a who-takes poll instead of the conflict sentence when the flag is on', async () => {
    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const seeded = await seedPair();
    const start = new Date('2026-09-25T19:00:00.000Z');
    const end = new Date('2026-09-25T20:00:00.000Z');
    await db.database.insert(schema.parentCalendarBlocks).values([
      {
        integrationId: seeded.primaryIntegrationId,
        eventId: 'gym',
        familyId: seeded.familyId,
        userId: seeded.primaryUserId,
        startAt: start,
        endAt: end,
        kidRelated: true,
        title: 'Maya gymnastics',
        status: 'confirmed',
        updatedStamp: 'stamp-gym',
      },
      {
        integrationId: seeded.coparentIntegrationId,
        eventId: 'busy',
        familyId: seeded.familyId,
        userId: seeded.coparentUserId,
        startAt: start,
        endAt: end,
        kidRelated: false,
        title: null,
        status: 'confirmed',
        updatedStamp: 'stamp-busy',
      },
    ]);
    const wire = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date('2026-09-23T14:00:00.000Z'),
      fetch: wire.fetch,
      voice: wire.voice,
    });
    expect(wire.texts()).toHaveLength(1);
    expect(wire.texts()[0]).toBe(
      fakeSpokenLineBody(
        groupLineInput(
          {
            kind: 'who_takes',
            kid: 'Maya',
            event: 'gymnastics',
            day: formatDay(start, 'America/Toronto', 'en'),
            time: formatTime(start, 'America/Toronto', 'en'),
          },
          'en',
        ),
      ),
    );
    expect(wire.texts()[0]).not.toContain("you're both busy");
    expect(wire.texts()[0]).not.toContain('conflict:');
    expect(wire.texts()[0]).not.toContain('Quarterly');
    expect(wire.pollOptions().slice(0, 2).sort()).toEqual(['Barton', 'Sam']);
    expect(wire.pollOptions().at(-1)).toBe("We'll figure it out");
    expect(wire.urls().some((url) => url.includes('/polls'))).toBe(true);
    expect(wire.urls().some((url) => url.includes('twilio.com'))).toBe(false);
    const options = await db.database
      .select({
        pollKind: schema.linqPollOptions.pollKind,
        choiceKind: schema.linqPollOptions.choiceKind,
        optionText: schema.linqPollOptions.optionText,
      })
      .from(schema.linqPollOptions);
    expect(options.map((row) => row.optionText).sort()).toEqual([
      'Barton',
      'Sam',
      "We'll figure it out",
    ]);
    expect(options.every((row) => row.pollKind === 'who_takes')).toBe(true);
    expect(options.find((row) => row.optionText === "We'll figure it out")?.choiceKind).toBe(
      'figure_it_out',
    );
  });

  it('keeps the conflict sentence and skips the poll when the flag is off', async () => {
    vi.stubEnv('LINQ_POLLS', '');
    const seeded = await seedPair();
    const start = new Date('2026-09-25T19:00:00.000Z');
    await db.database.insert(schema.parentCalendarBlocks).values([
      {
        integrationId: seeded.primaryIntegrationId,
        eventId: 'gym',
        familyId: seeded.familyId,
        userId: seeded.primaryUserId,
        startAt: start,
        endAt: new Date('2026-09-25T20:00:00.000Z'),
        kidRelated: true,
        title: 'Maya gymnastics',
        status: 'confirmed',
        updatedStamp: 'stamp-gym',
      },
      {
        integrationId: seeded.coparentIntegrationId,
        eventId: 'busy',
        familyId: seeded.familyId,
        userId: seeded.coparentUserId,
        startAt: start,
        endAt: new Date('2026-09-25T20:00:00.000Z'),
        kidRelated: false,
        title: null,
        status: 'confirmed',
        updatedStamp: 'stamp-busy',
      },
    ]);
    const wire = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date('2026-09-23T14:00:00.000Z'),
      fetch: wire.fetch,
      voice: wire.voice,
    });
    expect(wire.texts()).toHaveLength(1);
    expect(wire.texts()[0]).toContain('conflict:');
    expect(wire.pollOptions()).toEqual([]);
    expect(wire.urls().some((url) => url.includes('/polls'))).toBe(false);
  });

  it('does not poll a conflict during quiet hours or after the daily cap', async () => {
    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const seeded = await seedPair();
    const start = new Date('2026-09-25T19:00:00.000Z');
    const end = new Date('2026-09-25T20:00:00.000Z');
    await db.database.insert(schema.parentCalendarBlocks).values([
      {
        integrationId: seeded.primaryIntegrationId,
        eventId: 'gym',
        familyId: seeded.familyId,
        userId: seeded.primaryUserId,
        startAt: start,
        endAt: end,
        kidRelated: true,
        title: 'Maya gymnastics',
        status: 'confirmed',
        updatedStamp: 'stamp-gym',
      },
      {
        integrationId: seeded.coparentIntegrationId,
        eventId: 'busy',
        familyId: seeded.familyId,
        userId: seeded.coparentUserId,
        startAt: start,
        endAt: end,
        kidRelated: false,
        title: null,
        status: 'confirmed',
        updatedStamp: 'stamp-busy',
      },
    ]);
    const quiet = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: QUIET,
      fetch: quiet.fetch,
      voice: quiet.voice,
    });
    expect(quiet.texts()).toEqual([]);
    expect(quiet.pollOptions()).toEqual([]);

    const cappedAt = new Date('2026-09-23T14:00:00.000Z');
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.primaryUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'calendar_alert',
      templateKey: 'linq:group_kid_event',
      providerChatId: GROUP,
      status: 'sent',
      sentAt: cappedAt,
      createdAt: cappedAt,
    });
    const capped = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: cappedAt,
      fetch: capped.fetch,
      voice: capped.voice,
    });
    expect(capped.texts()).toEqual([]);
    expect(capped.pollOptions()).toEqual([]);
  });

  it('uses a vote at the evening handoff and does not invent a taker without one', async () => {
    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const start = new Date('2026-09-25T19:00:00.000Z');
    const end = new Date('2026-09-25T20:00:00.000Z');
    const askedAt = new Date('2026-09-23T14:00:00.000Z');

    const unanswered = await seedPair();
    await insertSharedKid(unanswered, start, end);
    const ask = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: unanswered.familyId,
      now: askedAt,
      fetch: ask.fetch,
      voice: ask.voice,
    });
    expect(ask.pollOptions().slice(0, 2).sort()).toEqual(['Barton', 'Sam']);
    expect(ask.pollOptions().at(-1)).toBe("We'll figure it out");
    await db.database
      .update(schema.channelMessages)
      .set({ createdAt: askedAt })
      .where(eq(schema.channelMessages.familyId, unanswered.familyId));
    const later = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: unanswered.familyId,
      now: HANDOFF_AT,
      fetch: later.fetch,
      voice: later.voice,
    });
    expect(later.texts().join('\n')).not.toContain('handoff:');

    await db.exec('truncate table families, users cascade');
    const voted = await seedPair();
    await insertSharedKid(voted, start, end);
    const first = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: voted.familyId,
      now: askedAt,
      fetch: first.fetch,
      voice: first.voice,
    });
    const sam = await db.database
      .select({
        subjectKey: schema.linqPollOptions.subjectKey,
        choiceKind: schema.linqPollOptions.choiceKind,
        choiceValue: schema.linqPollOptions.choiceValue,
        optionText: schema.linqPollOptions.optionText,
        pollKind: schema.linqPollOptions.pollKind,
      })
      .from(schema.linqPollOptions)
      .where(eq(schema.linqPollOptions.optionText, 'Sam'));
    const option = sam[0];
    expect(option?.subjectKey).toBeTruthy();
    await db.database
      .update(schema.channelMessages)
      .set({ createdAt: askedAt })
      .where(eq(schema.channelMessages.familyId, voted.familyId));
    await recordLogisticsVote(db.database, {
      familyId: voted.familyId,
      parentUserId: voted.coparentUserId,
      subjectKey: option?.subjectKey ?? '',
      pollKind: 'who_takes',
      choiceKind: option?.choiceKind ?? null,
      choiceValue: option?.choiceValue ?? null,
      optionText: option?.optionText ?? '',
      now: askedAt,
    });
    const handoff = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: voted.familyId,
      now: HANDOFF_AT,
      fetch: handoff.fetch,
      voice: handoff.voice,
    });
    expect(handoff.texts().join('\n')).toContain('handoff: Sam, Maya');
    expect(handoff.pollOptions()).toEqual([]);

    const stored = await captureLogisticsText(db.database, {
      familyId: voted.familyId,
      parentUserId: voted.primaryUserId,
      body: "I'll take it",
      now: HANDOFF_AT,
    });
    expect(stored).toBe('stored');
    const facts = await db.database
      .select({ factValue: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, voted.familyId),
          eq(schema.familyMemoryFacts.factType, 'logistic'),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    const live = facts.map((row) => row.factValue as { status?: string; takerUserId?: string });
    expect(
      live.some((row) => row.status === 'decided' && row.takerUserId === voted.primaryUserId),
    ).toBe(true);
  });

  it('stores nothing when they pass and does not ask again that day', async () => {
    vi.stubEnv('LINQ_POLLS', 'on');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const start = new Date('2026-09-25T19:00:00.000Z');
    const end = new Date('2026-09-25T20:00:00.000Z');
    const askedAt = new Date('2026-09-23T14:00:00.000Z');
    const seeded = await seedPair();
    await insertSharedKid(seeded, start, end);
    const ask = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: askedAt,
      fetch: ask.fetch,
      voice: ask.voice,
    });
    const pass = await db.database
      .select({
        subjectKey: schema.linqPollOptions.subjectKey,
        choiceKind: schema.linqPollOptions.choiceKind,
        choiceValue: schema.linqPollOptions.choiceValue,
        optionText: schema.linqPollOptions.optionText,
      })
      .from(schema.linqPollOptions)
      .where(eq(schema.linqPollOptions.optionText, "We'll figure it out"));
    const option = pass[0];
    expect(option?.choiceKind).toBe('figure_it_out');
    const vote = await recordLogisticsVote(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.primaryUserId,
      subjectKey: option?.subjectKey ?? '',
      pollKind: 'who_takes',
      choiceKind: option?.choiceKind ?? null,
      choiceValue: option?.choiceValue ?? null,
      optionText: option?.optionText ?? '',
      now: askedAt,
    });
    expect(vote).toBe('passed');
    const live = await db.database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, seeded.familyId),
          eq(schema.familyMemoryFacts.factType, 'logistic'),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(live).toEqual([]);
    await db.database
      .update(schema.channelMessages)
      .set({ createdAt: askedAt })
      .where(eq(schema.channelMessages.familyId, seeded.familyId));
    const again = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: new Date(askedAt.getTime() + 60 * 60 * 1000),
      fetch: again.fetch,
      voice: again.voice,
    });
    expect(again.texts().join('\n')).not.toContain('conflict:');
    expect(again.pollOptions()).toEqual([]);
    const evening = pollWire();
    await narrateHouseholdCalendar(db.database, {
      familyId: seeded.familyId,
      now: HANDOFF_AT,
      fetch: evening.fetch,
      voice: evening.voice,
    });
    expect(evening.texts().join('\n')).not.toContain('handoff:');
  });
});

async function insertSharedKid(
  seeded: {
    familyId: string;
    primaryUserId: string;
    coparentUserId: string;
    primaryIntegrationId: string;
    coparentIntegrationId: string;
  },
  start: Date,
  end: Date,
): Promise<void> {
  await db.database.insert(schema.parentCalendarBlocks).values([
    {
      integrationId: seeded.primaryIntegrationId,
      eventId: 'gym-a',
      familyId: seeded.familyId,
      userId: seeded.primaryUserId,
      startAt: start,
      endAt: end,
      kidRelated: true,
      title: 'Maya gymnastics',
      status: 'confirmed',
      updatedStamp: 'stamp-a',
    },
    {
      integrationId: seeded.coparentIntegrationId,
      eventId: 'gym-b',
      familyId: seeded.familyId,
      userId: seeded.coparentUserId,
      startAt: start,
      endAt: end,
      kidRelated: true,
      title: 'Maya gymnastics',
      status: 'confirmed',
      updatedStamp: 'stamp-b',
    },
  ]);
}

function pollWire(): {
  fetch: typeof fetch;
  texts: () => string[];
  pollOptions: () => string[];
  urls: () => string[];
  voice: GroupVoice;
} {
  const texts: string[] = [];
  const pollOptions: string[] = [];
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const message = body?.message as { parts?: { type?: string; value?: string }[] } | undefined;
    for (const part of message?.parts ?? []) {
      if (part.type === 'text' && part.value) texts.push(part.value);
    }
    const poll = body?.poll as { options?: { text?: string }[] } | undefined;
    const options = poll?.options ?? [];
    if (options.length > 0) {
      for (const option of options) {
        if (option.text) pollOptions.push(option.text);
      }
      return new Response(
        JSON.stringify({
          message_id: `poll-${pollOptions.length}`,
          poll: {
            options: options.map((option, index) => ({
              option_id: `opt-${pollOptions.length}-${index}`,
              text: option.text,
            })),
          },
        }),
        { status: 202 },
      );
    }
    return new Response(JSON.stringify({ message: { id: `m-${texts.length}` } }), { status: 201 });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: () => texts,
    pollOptions: () => pollOptions,
    urls: () => urls,
    voice: fakeSpokenLineComposer(),
  };
}
