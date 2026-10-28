import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { takeGroupRsvpTurn } from './group-rsvp';
import { createGroupRsvpCalendarPort } from './group-rsvp-calendar';
import {
  fakeGroupRsvpCalendar,
  fakeGroupRsvpComposer,
  fakeGroupRsvpReader,
} from './group-rsvp-fake';
import { playGroupRsvpPreview } from './group-rsvp-preview';
import type { GroupRsvpReadInput, GroupRsvpReading } from './group-rsvp-read';
import { handleLinqInboundRequest } from './inbound';
import { joinFamilyToSharedGroup } from './multi-family';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PRIYA = '+14165550111';
const JORDAN = '+14165550222';
const FROM = '+16462352164';
const NOW = new Date('2026-10-10T18:00:00.000Z');
const CHAT = 'chat-room-4-parents';
const PARTY_START = new Date('2026-10-17T18:00:00.000Z');

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
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('BROWSER_USE_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(phone: string, name: string, claimChat = false) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: `${name} household`,
      provinceOrState: 'ON',
      linqGroupChatId: claimChat ? CHAT : null,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
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
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
}

function readingFor(input: GroupRsvpReadInput): GroupRsvpReading | null {
  const text = input.text.toLowerCase();
  if (/keep track|who's coming|whos coming|count/.test(text) && /party|maya/.test(text)) {
    return {
      intent: 'track',
      confidence: 0.95,
      event: {
        title: "Maya's party",
        whenText: PARTY_START.toISOString(),
        location: 'the park',
      },
      householdName: input.senderName,
    };
  }
  if (/count|how many|who's in|whos in/.test(text) && input.tracking) {
    return {
      intent: 'report',
      confidence: 0.9,
      event: { title: null, whenText: null, location: null },
      householdName: input.senderName,
    };
  }
  if (/calendar/.test(text) && /yes|sure|ok|please/.test(text) && input.tracking) {
    return {
      intent: 'permission_yes',
      confidence: 0.93,
      event: { title: null, whenText: null, location: null },
      householdName: input.senderName,
    };
  }
  if (/we'll be there|we will be there|count us in|heart/.test(text) || input.tapback === 'like') {
    return {
      intent: 'yes',
      confidence: 0.94,
      event: { title: null, whenText: null, location: null },
      householdName: input.senderName,
    };
  }
  if (/can't make|cannot make|we're out/.test(text) || input.tapback === 'dislike') {
    return {
      intent: 'no',
      confidence: 0.92,
      event: { title: null, whenText: null, location: null },
      householdName: input.senderName,
    };
  }
  return {
    intent: 'chatter',
    confidence: 0.9,
    event: { title: null, whenText: null, location: null },
    householdName: input.senderName,
  };
}

describe('VIL-102 group RSVP tally', () => {
  it('does nothing before a parent asks Hale to track, including during banter', async () => {
    await seedFamily(PRIYA, 'Priya', true);
    const reader = fakeGroupRsvpReader(readingFor);
    const voice = fakeGroupRsvpComposer();
    const texts: string[] = [];
    const quiet = await takeGroupRsvpTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: 'anyone bringing chips?',
        tapback: null,
        providerMessageId: 'banter-1',
        receivedAt: NOW,
        now: NOW,
      },
      {
        reader,
        voice,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: 'out-1' };
        },
      },
    );
    expect(quiet).toEqual({ handled: false });
    expect(texts).toEqual([]);
    expect(await db.database.select().from(schema.linqGroupRsvpPlans)).toEqual([]);
  });

  it('stays silent when keys are unset and no reader is injected', async () => {
    await seedFamily(PRIYA, 'Priya', true);
    const texts: string[] = [];
    const unread = await takeGroupRsvpTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: "Hale can you keep track of who is coming to Maya's party Saturday",
        tapback: null,
        providerMessageId: 'ask-1',
        receivedAt: NOW,
        now: NOW,
      },
      {
        reader: null,
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: 'out-1' };
        },
      },
    );
    expect(unread).toEqual({ handled: false });
    expect(texts).toEqual([]);
  });

  it('plays the 3-family birthday party: tally, tapbacks, calendar after permission, quiet banter', async () => {
    const priya = await seedFamily(PRIYA, 'Priya', true);
    const jordan = await seedFamily(JORDAN, 'Jordan');
    const noop = async () => ({ providerMessageId: 'join' });
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: priya.familyId,
      userId: priya.userId,
      phone: PRIYA,
      verbatim: 'our family is in this group',
      now: NOW,
      send: noop,
    });
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: jordan.familyId,
      userId: jordan.userId,
      phone: JORDAN,
      verbatim: 'our family is in this group',
      now: NOW,
      send: noop,
    });

    const played = await playGroupRsvpPreview(db.database, {
      chatId: CHAT,
      now: NOW,
      reader: fakeGroupRsvpReader(readingFor),
      voice: fakeGroupRsvpComposer(),
      calendar: fakeGroupRsvpCalendar(createGroupRsvpCalendarPort(db.database)),
    });

    expect(played.before.haleLines).toEqual([]);
    expect(played.after.filter((turn) => turn.outcome).map((turn) => turn.outcome)).toEqual([
      'rsvp_started',
      'rsvp_quiet',
      'rsvp_tally',
      'rsvp_calendar_placed',
      'rsvp_tally',
      'rsvp_quiet',
      'rsvp_tally',
    ]);
    expect(played.after.filter((turn) => turn.from === 'Hale').map((turn) => turn.text)).toEqual([
      "I'll keep the count for Maya's party. 0 yes, 0 no, 2 pending.",
      "1 yes, 0 no, 1 pending for Maya's party. Jordan, want it on your calendar?",
      "Jordan is on the calendar for Maya's party. 1 yes, 0 no, 1 pending.",
      "1 yes, 1 no, 1 pending for Maya's party.",
      "2 yes, 1 no, 0 pending for Maya's party. Priya, want it on your calendar?",
    ]);
    expect(played.calendarWrites).toEqual([{ familyId: jordan.familyId, title: "Maya's party" }]);
    const events = await db.database.select().from(schema.familyEvents);
    expect(
      events.map((row) => ({ familyId: row.familyId, title: row.title, source: row.source })),
    ).toEqual([{ familyId: jordan.familyId, title: "Maya's party", source: 'channel' }]);
    const replies = await db.database.select().from(schema.linqGroupRsvpReplies);
    expect(replies.map((row) => row.response).sort()).toEqual(['no', 'yes', 'yes']);
    expect(
      replies.some((row) => row.householdKey.startsWith('phone:') && row.response === 'no'),
    ).toBe(true);
  });

  it('starts the tally from a claimed household group, not the coach door', async () => {
    const priya = await seedFamily(PRIYA, 'Priya', true);
    const secret = Buffer.alloc(32, 9);
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${secret.toString('base64')}`);
    vi.stubEnv('LINQ_FROM_E164', FROM);
    const sends: string[] = [];
    const body = JSON.stringify({
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt-rsvp-claimed',
      created_at: NOW.toISOString(),
      data: {
        chat: { id: CHAT, is_group: true },
        id: 'msg-track',
        direction: 'inbound',
        sender_handle: { handle: PRIYA, is_me: false },
        parts: [
          {
            type: 'text',
            value: "Hale can you keep track of who's coming to Maya's party Saturday",
          },
        ],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const mac = createHmac('sha256', secret)
      .update(`evt-rsvp-claimed.${ts}.${body}`)
      .digest('base64');
    const response = await handleLinqInboundRequest(
      new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'evt-rsvp-claimed',
          'webhook-timestamp': ts,
          'webhook-signature': `v1,${mac}`,
        },
        body,
      }),
      {
        database: db.database,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        countOutcome: async () => {},
        now: () => NOW,
        groupRsvpReader: fakeGroupRsvpReader(readingFor),
        groupRsvpVoice: fakeGroupRsvpComposer(),
        sendGroupText: async ({ text }: { text: string }) => {
          sends.push(text);
          return { providerMessageId: 'out-claimed' };
        },
      } as unknown as Parameters<typeof handleLinqInboundRequest>[1],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'rsvp_started' });
    expect(sends).toEqual(["I'll keep the count for Maya's party. 0 yes, 0 no, 1 pending."]);
    const plans = await db.database.select().from(schema.linqGroupRsvpPlans);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.hostFamilyId).toBe(priya.familyId);
  });

  it("does not write a calendar without that household's yes to the write", async () => {
    const priya = await seedFamily(PRIYA, 'Priya', true);
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: priya.familyId,
      userId: priya.userId,
      phone: PRIYA,
      verbatim: 'our family is in this group',
      now: NOW,
      send: async () => ({ providerMessageId: 'join' }),
    });
    const calendar = fakeGroupRsvpCalendar();
    const reader = fakeGroupRsvpReader(readingFor);
    const voice = fakeGroupRsvpComposer();
    const send = async ({ text }: { text: string }) => ({ providerMessageId: text });
    await takeGroupRsvpTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: "Hale keep track of who is coming to Maya's party Saturday at the park",
        tapback: null,
        providerMessageId: 'p1',
        receivedAt: NOW,
        now: NOW,
      },
      { reader, voice, send, calendar },
    );
    await takeGroupRsvpTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: 'count us in',
        tapback: null,
        providerMessageId: 'p2',
        receivedAt: NOW,
        now: NOW,
      },
      { reader, voice, send, calendar },
    );
    expect(calendar.writes).toEqual([]);
    const events = await db.database.select().from(schema.familyEvents);
    expect(events).toEqual([]);
  });
});
