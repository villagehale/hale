import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptCoParentInvite } from '~/lib/channel/coparent/accept';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import { deliverCoParentNumberInvite } from '~/lib/channel/linq/coparent-invite';
import {
  createChatReplyTransport,
  createOutboundTransport,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { CoParentInvite } from './invites';

const FLAG = 'THIRD_PARTY_INVITE_ROUTE_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const PERSON_PHONE = '+16475550199';
const LINE = '+16475550100';
const PARENT_CHAT = 'chat-parent-1';
const PERSON_CHAT = 'chat-person-1';
const OPS_WEBHOOK = 'https://ops.example.test/hook';
const NOW = new Date('2026-11-23T15:00:00.000Z');
const ADD_CO_PARENT = 'add Sam 647-555-0199 as my partner';
const ADD_CAREGIVER = 'add grandma 647-555-0199 as grandparent';

type LinqPost = {
  path: string;
  to: string[] | null;
  key: string | null;
  text: string | null;
};

let db: TestDb;
let posts: LinqPost[];
let pages: string[];
/** Paths whose next POST times out, in order. */
let timeouts: string[];
let inboundCount = 0;

function readPost(url: string, body: Record<string, unknown>): LinqPost {
  const message = body.message as
    | { idempotency_key?: string; parts?: Array<{ value?: string }> }
    | undefined;
  return {
    path: new URL(url).pathname.replace(/^.*\/v3/, ''),
    to: Array.isArray(body.to) ? (body.to as string[]) : null,
    key: message?.idempotency_key ?? null,
    text: message?.parts?.[0]?.value ?? null,
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === OPS_WEBHOOK) {
        pages.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return new Response('ok', { status: 200 });
      }
      const post = readPost(href, JSON.parse(String(init?.body)) as Record<string, unknown>);
      posts.push(post);
      if (timeouts[0] === post.path) {
        timeouts.shift();
        throw new DOMException('aborted', 'AbortError');
      }
      const id = `out-${posts.length}`;
      const payload =
        post.path === '/chats'
          ? { chat: { id: `chat-new-${posts.length}`, message: { id } } }
          : { message: { id } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  posts = [];
  pages = [];
  timeouts = [];
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', LINE);
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', OPS_WEBHOOK);
  vi.stubEnv(FLAG, 'true');
  stubFetch();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedHousehold(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Ana + kids',
      onboardingStage: 'sms_active',
      country: 'CA',
      provinceOrState: 'ON',
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(PARENT_PHONE)}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

function iMessageDeps(chatId: string): IntakeDeps {
  return {
    transport: createChatReplyTransport({ chatId, replyToMessageId: null }),
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    friendVoice: scriptedFriendVoice,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    consent: yesNoReader(),
    consentAsk: askWriter(),
    now: NOW,
  };
}

async function parentSays(body: string) {
  inboundCount += 1;
  return handleInboundSms(
    db.database,
    {
      from: PARENT_PHONE,
      body,
      providerId: `in-parent-${inboundCount}`,
      receivedAt: NOW,
      transport: 'imessage',
      chatId: PARENT_CHAT,
    },
    iMessageDeps(PARENT_CHAT),
  );
}

async function personSays(body: string) {
  inboundCount += 1;
  return handleInboundSms(
    db.database,
    {
      from: PERSON_PHONE,
      body,
      providerId: `in-person-${inboundCount}`,
      receivedAt: NOW,
      transport: 'imessage',
      chatId: PERSON_CHAT,
    },
    iMessageDeps(PERSON_CHAT),
  );
}

async function inviteRow(familyId: string) {
  const rows = await db.database
    .select({
      id: schema.caregiverInvites.id,
      state: schema.caregiverInvites.state,
      closedAt: schema.caregiverInvites.closedAt,
    })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.familyId, familyId));
  expect(rows).toHaveLength(1);
  return rows[0] as NonNullable<(typeof rows)[number]>;
}

function postsToPerson(): LinqPost[] {
  return posts.filter((post) => post.path === '/chats' && post.to?.[0] === PERSON_PHONE);
}

function postsIntoParentChat(): LinqPost[] {
  return posts.filter((post) => post.path === `/chats/${PARENT_CHAT}/messages`);
}

async function seatsFor(familyId: string, role: 'co_parent' | 'grandparent'): Promise<number> {
  const rows = await db.database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.role, role)));
  return rows.length;
}

describe('flag on: an invite reaches the person it is for', () => {
  it('posts the co-parent invite to their number and the ack into the parent chat', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    posts.length = 0;

    const outcome = await parentSays('yes');

    expect(outcome.status).toBe('co_parent_invite_sent');
    const [invite] = postsToPerson();
    expect(invite?.text).toBe('Ana added you as a co-parent. Reply STOP anytime.');
    expect(invite?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(postsIntoParentChat().map((post) => post.text)).not.toContain(invite?.text);
    expect(postsIntoParentChat()).toHaveLength(1);
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });

  it('posts a caregiver invite to their number and not the parent chat', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CAREGIVER);
    posts.length = 0;

    const outcome = await parentSays('yes');

    expect(outcome.status).toBe('caregiver_invite_sent');
    expect(postsToPerson()).toHaveLength(1);
    expect(postsToPerson()[0]?.text).toContain('added you as');
    expect(postsIntoParentChat()).toHaveLength(1);
    expect(postsIntoParentChat()[0]?.text).not.toContain('added you as');
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });

  it('on a Linq timeout: no ack, row back with the parent, #ops paged, next yes re-sends under one key', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    posts.length = 0;
    timeouts = ['/chats'];

    const failed = await parentSays('yes');

    expect(failed.status).toBe('co_parent_invite_unsent');
    expect(postsIntoParentChat()).toHaveLength(0);
    const held = await inviteRow(familyId);
    expect(held.state).toBe('awaiting_parent_assent');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('third_party_invite_unsent');
    expect(pages[0]).toContain('why unclear');
    expect(pages[0]).not.toContain(PERSON_PHONE);
    const audit = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetId, held.id),
          eq(schema.auditLog.actionTaken, 'third_party_invite_send_failed'),
        ),
      );
    expect(audit).toHaveLength(1);

    const retried = await parentSays('yes');

    expect(retried.status).toBe('co_parent_invite_sent');
    const attempts = postsToPerson();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(postsIntoParentChat()).toHaveLength(1);
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });

  it('a redelivery of the same yes texts nobody and leaves the row with the parent', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    posts.length = 0;
    timeouts = ['/chats'];
    const yes = {
      from: PARENT_PHONE,
      body: 'yes',
      providerId: 'in-parent-redelivered',
      receivedAt: NOW,
      transport: 'imessage' as const,
      chatId: PARENT_CHAT,
    };
    await handleInboundSms(db.database, yes, iMessageDeps(PARENT_CHAT));
    expect(postsToPerson()).toHaveLength(1);

    await expect(handleInboundSms(db.database, yes, iMessageDeps(PARENT_CHAT))).rejects.toThrow(
      /channel_messages_inbound_provider_msg_uniq/,
    );

    expect(postsToPerson()).toHaveLength(1);
    expect((await inviteRow(familyId)).state).toBe('awaiting_parent_assent');
  });

  it('a caregiver invite whose send times out goes back the same way', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CAREGIVER);
    posts.length = 0;
    timeouts = ['/chats'];

    const failed = await parentSays('yes');

    expect(failed.status).toBe('caregiver_invite_unsent');
    expect(postsIntoParentChat()).toHaveLength(0);
    expect((await inviteRow(familyId)).state).toBe('awaiting_parent_assent');
    expect(pages).toHaveLength(1);

    const retried = await parentSays('yes');

    expect(retried.status).toBe('caregiver_invite_sent');
    expect(postsToPerson()).toHaveLength(2);
    expect(postsToPerson()[1]?.key).toBe(postsToPerson()[0]?.key);
  });

  it("a person's yes while the row waits on the parent seats nobody", async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    timeouts = ['/chats'];
    await parentSays('yes');

    await personSays('yes');

    expect(await seatsFor(familyId, 'co_parent')).toBe(0);
    expect((await inviteRow(familyId)).state).toBe('awaiting_parent_assent');
  });

  it("once the parent's retry lands, the person's yes seats them", async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    timeouts = ['/chats'];
    await parentSays('yes');
    await parentSays('yes');

    await personSays('yes');

    expect(await seatsFor(familyId, 'co_parent')).toBe(1);
    expect((await inviteRow(familyId)).state).toBe('accepted');
  });

  it('the seating claim refuses a row that went back to the parent', async () => {
    const { familyId, parentUserId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    const row = await inviteRow(familyId);
    const invite: CoParentInvite = {
      id: row.id,
      familyId,
      invitedByUserId: parentUserId,
      displayName: 'Sam',
      phoneE164: PERSON_PHONE,
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      role: 'co_parent',
    };

    const result = await acceptCoParentInvite(db.database, {
      invite,
      verbatimReply: 'yes',
      now: NOW,
    });

    expect(result.outcome).toBe('lost_race');
    expect(await seatsFor(familyId, 'co_parent')).toBe(0);
    expect((await inviteRow(familyId)).closedAt).toBeNull();
  });

  it('a stop still closes a row that went back to the parent', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    timeouts = ['/chats'];
    await parentSays('yes');

    await personSays('STOP');

    const row = await inviteRow(familyId);
    expect(row.state).toBe('declined');
    expect(row.closedAt).not.toBeNull();
  });

  it('a newer ask opened during the failed send keeps the only pending seat', async () => {
    const { familyId, parentUserId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    const first = await inviteRow(familyId);
    const newerPhone = '+16475550188';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href === OPS_WEBHOOK) {
          pages.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return new Response('ok', { status: 200 });
        }
        await db.database.insert(schema.caregiverInvites).values({
          familyId,
          invitedByUserId: parentUserId,
          role: 'grandparent',
          displayName: 'Lee',
          phoneE164Encrypted: encryptString(newerPhone),
          phoneE164Hash: phoneBlindIndex(newerPhone),
          state: 'awaiting_parent_assent',
          expiresAt: new Date(NOW.getTime() + 3_600_000),
          createdAt: NOW,
        });
        throw new DOMException('aborted', 'AbortError');
      }),
    );

    await parentSays('yes');

    const rows = await db.database
      .select({ id: schema.caregiverInvites.id, state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites)
      .where(eq(schema.caregiverInvites.familyId, familyId));
    expect(rows.filter((row) => row.state === 'awaiting_parent_assent')).toHaveLength(1);
    expect(rows.find((row) => row.id === first.id)?.state).toBe('awaiting_caregiver_reply');
    expect(pages).toHaveLength(1);
  });

  it("tells the inviter the person joined through the phone door, not the person's chat", async () => {
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    await parentSays('yes');
    posts.length = 0;

    const outcome = await personSays('yes');

    expect(outcome.status).toBe('co_parent_accepted');
    expect(await seatsFor(familyId, 'co_parent')).toBe(1);
    const toInviter = posts.filter(
      (post) => post.path === '/chats' && post.to?.[0] === PARENT_PHONE,
    );
    expect(toInviter).toHaveLength(1);
    expect(posts.filter((post) => post.path === `/chats/${PERSON_CHAT}/messages`)).toHaveLength(1);
  });
});

describe('flag on: the number door', () => {
  async function seedAsk(seeded: { familyId: string; parentUserId: string }): Promise<void> {
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: INTAKE_COPARENT_ASK_TEMPLATE_KEY,
      providerMessageId: `ask-${seeded.parentUserId}`,
      status: 'sent',
      sentAt: NOW,
    });
  }

  function numberTurn(seeded: { familyId: string; parentUserId: string }) {
    return deliverCoParentNumberInvite(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      body: 'Sam 647-555-0199',
      now: NOW,
      inboundChannelMessageId: null,
      sendSms: async (sms) => {
        const sent = await sendResolvingNewChat(createOutboundTransport(), sms);
        return { providerMessageId: sent.providerMessageId };
      },
      ask: askWriter(),
    });
  }

  it('records the yes first, and a failed send goes back with no ack and one key on retry', async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);
    timeouts = ['/chats'];

    const failed = await numberTurn(seeded);

    expect(failed).toMatchObject({ status: 'invite_unsent', reply: null });
    const held = await inviteRow(seeded.familyId);
    expect(held.state).toBe('awaiting_parent_assent');
    const grants = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.consentType, 'co_parent_access_grant'));
    expect(grants).toHaveLength(1);
    expect(pages).toHaveLength(1);

    const retried = await parentSays('yes');

    expect(retried.status).toBe('co_parent_invite_sent');
    const attempts = postsToPerson();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
  });

  it('a sent number invite carries the row key and still acks', async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);

    const sent = await numberTurn(seeded);

    expect(sent.status).toBe('sent');
    expect(postsToPerson()).toHaveLength(1);
    expect(postsToPerson()[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    expect((await inviteRow(seeded.familyId)).state).toBe('awaiting_caregiver_reply');
  });
});

describe('flag off', () => {
  it("keeps main's route: the invite goes into the turn's chat with no row key", async () => {
    vi.stubEnv(FLAG, 'TRUE');
    const { familyId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    posts.length = 0;

    const outcome = await parentSays('yes');

    expect(outcome.status).toBe('co_parent_invite_sent');
    expect(postsToPerson()).toHaveLength(0);
    expect(postsIntoParentChat()).toHaveLength(2);
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });
});
