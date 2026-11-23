import { createHash } from 'node:crypto';
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
import {
  type CaregiverLaneInvite,
  type CoParentInvite,
  InviteNotAwaitingReply,
  acceptInvite,
} from './invites';

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
/** HTTP statuses Linq answers the next invite POSTs with, in order. */
let linqStatuses: number[];
let opsStatus: number;
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
        return new Response('ok', { status: opsStatus });
      }
      const post = readPost(href, JSON.parse(String(init?.body)) as Record<string, unknown>);
      posts.push(post);
      if (timeouts[0] === post.path) {
        timeouts.shift();
        throw new DOMException('aborted', 'AbortError');
      }
      if (post.path === '/chats' && linqStatuses.length > 0) {
        return new Response('{}', { status: linqStatuses.shift() as number });
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
  linqStatuses = [];
  opsStatus = 200;
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

function linqKey(lane: 'co_parent' | 'caregiver', inviteId: string): string {
  return createHash('sha256').update(`${lane}_invite:${inviteId}`).digest('hex');
}

async function failureAudit(inviteId: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, inviteId),
        eq(schema.auditLog.actionTaken, 'third_party_invite_send_failed'),
      ),
    );
}

async function rowById(inviteId: string) {
  const [row] = await db.database
    .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.id, inviteId));
  return row;
}

async function newestRowId(familyId: string, otherThan: string): Promise<string> {
  const rows = await db.database
    .select({ id: schema.caregiverInvites.id })
    .from(schema.caregiverInvites)
    .where(eq(schema.caregiverInvites.familyId, familyId));
  const other = rows.find((row) => row.id !== otherThan);
  expect(other).toBeTruthy();
  return other?.id as string;
}

function expectPagedOnce(why: 'refused' | 'unclear'): void {
  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain('third_party_invite_unsent');
  expect(pages[0]).toContain(`why ${why}`);
  expect(pages[0]).not.toContain(PERSON_PHONE);
  expect(pages[0]).not.toContain('Sam');
  expect(pages[0]).not.toContain('added you');
}

const LANES = [
  {
    lane: 'co_parent',
    add: ADD_CO_PARENT,
    seat: 'co_parent',
    sent: 'co_parent_invite_sent',
    unsent: 'co_parent_invite_unsent',
    accepted: 'co_parent_accepted',
    declined: 'co_parent_declined',
    alreadyInvited: { status: 'co_parent_add_refused', reason: 'already_invited' },
  },
  {
    lane: 'caregiver',
    add: ADD_CAREGIVER,
    seat: 'grandparent',
    sent: 'caregiver_invite_sent',
    unsent: 'caregiver_invite_unsent',
    accepted: 'caregiver_accepted',
    declined: 'caregiver_declined',
    alreadyInvited: { status: 'caregiver_add_refused', reason: 'already_invited' },
  },
] as const;

const UNCLEAR_FAILURES: ReadonlyArray<readonly [string, () => void]> = [
  [
    'a timeout',
    () => {
      timeouts = ['/chats'];
    },
  ],
  [
    'a 500',
    () => {
      linqStatuses = [500];
    },
  ],
];

describe.each(LANES)('flag on, the add command: $lane', (lane) => {
  it("posts to the person's number under the row's key, then acks the parent", async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    const row = await inviteRow(familyId);
    posts.length = 0;

    const outcome = await parentSays('yes');

    expect(outcome.status).toBe(lane.sent);
    expect(postsToPerson()).toHaveLength(1);
    expect(postsToPerson()[0]?.key).toBe(linqKey(lane.lane, row.id));
    expect(postsToPerson()[0]?.text).toContain('added you as');
    expect(postsIntoParentChat()).toHaveLength(1);
    expect(postsIntoParentChat()[0]?.text).not.toContain('added you as');
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
    expect(pages).toHaveLength(0);
  });

  it('a certain refusal closes the row unsent, pages, sends no ack, and a new invite works', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    const first = await inviteRow(familyId);
    posts.length = 0;
    linqStatuses = [400];

    const failed = await parentSays('yes');

    expect(failed).toEqual({ status: lane.unsent, opsPage: 'paged' });
    expect(postsIntoParentChat()).toHaveLength(0);
    const closed = await inviteRow(familyId);
    expect(closed.state).toBe('expired_unsent');
    expect(closed.closedAt).not.toBeNull();
    expectPagedOnce('refused');
    expect((await failureAudit(first.id)).map((row) => row.after)).toEqual([
      {
        role: lane.lane === 'co_parent' ? 'co_parent' : 'grandparent',
        why: 'refused',
        opsPage: 'paged',
        closedUnsent: true,
      },
    ]);

    posts.length = 0;
    await parentSays(lane.add);
    const again = await parentSays('yes');

    expect(again.status).toBe(lane.sent);
    const second = await newestRowId(familyId, first.id);
    expect(postsToPerson().map((post) => post.key)).toEqual([linqKey(lane.lane, second)]);
    expect((await rowById(second))?.state).toBe('awaiting_caregiver_reply');
  });

  it('a stop still binds to a row closed by a certain refusal', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    linqStatuses = [400];
    await parentSays('yes');
    expect((await inviteRow(familyId)).state).toBe('expired_unsent');

    await personSays('STOP');

    expect((await inviteRow(familyId)).state).toBe('declined');
    expect((await parentSays(lane.add)).status).toBe(lane.alreadyInvited.status);
  });

  it('a late yes from a number Linq refused hears nothing about an invitation', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    linqStatuses = [400];
    await parentSays('yes');
    posts.length = 0;

    const late = await personSays('yes');

    expect(late.status).not.toBe('invite_expired_answered');
    expect(await seatsFor(familyId, lane.seat)).toBe(0);
    expect((await inviteRow(familyId)).state).toBe('expired_unsent');
  });

  it('does not overwrite a stop that closed the row during the refused send', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    const row = await inviteRow(familyId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url) === OPS_WEBHOOK) {
          pages.push((JSON.parse(String(init?.body)) as { text: string }).text);
          return new Response('ok', { status: 200 });
        }
        await db.database
          .update(schema.caregiverInvites)
          .set({ state: 'declined', closedAt: NOW })
          .where(eq(schema.caregiverInvites.id, row.id));
        return new Response('{}', { status: 400 });
      }),
    );

    await parentSays('yes');

    expect((await inviteRow(familyId)).state).toBe('declined');
    expect((await failureAudit(row.id))[0]?.after).toMatchObject({
      why: 'refused',
      closedUnsent: false,
    });
  });

  describe.each(UNCLEAR_FAILURES)('after %s', (_name, failNextSend) => {
    async function unclearRow(familyId: string) {
      await parentSays(lane.add);
      const row = await inviteRow(familyId);
      posts.length = 0;
      failNextSend();
      const failed = await parentSays('yes');
      expect(failed).toEqual({ status: lane.unsent, opsPage: 'paged' });
      return row;
    }

    it('leaves the row waiting on the person, pages, and sends no ack', async () => {
      const { familyId } = await seedHousehold();
      const row = await unclearRow(familyId);

      expect(postsIntoParentChat()).toHaveLength(0);
      const held = await inviteRow(familyId);
      expect(held.state).toBe('awaiting_caregiver_reply');
      expect(held.closedAt).toBeNull();
      expectPagedOnce('unclear');
      expect((await failureAudit(row.id)).map((audit) => audit.after)).toEqual([
        {
          role: lane.lane === 'co_parent' ? 'co_parent' : 'grandparent',
          why: 'unclear',
          opsPage: 'paged',
          closedUnsent: false,
        },
      ]);
    });

    it("the person's yes seats them", async () => {
      const { familyId } = await seedHousehold();
      await unclearRow(familyId);

      const outcome = await personSays('yes');

      expect(outcome.status).toBe(lane.accepted);
      expect(await seatsFor(familyId, lane.seat)).toBe(1);
      expect((await inviteRow(familyId)).state).toBe('accepted');
    });

    it("the person's no declines it", async () => {
      const { familyId } = await seedHousehold();
      await unclearRow(familyId);

      const outcome = await personSays('no');

      expect(outcome.status).toBe(lane.declined);
      expect(await seatsFor(familyId, lane.seat)).toBe(0);
      expect((await inviteRow(familyId)).state).toBe('declined');
    });

    it("the person's stop closes it", async () => {
      const { familyId } = await seedHousehold();
      await unclearRow(familyId);

      await personSays('STOP');

      const row = await inviteRow(familyId);
      expect(row.state).toBe('declined');
      expect(row.closedAt).not.toBeNull();
    });

    it('a re-invite is refused as already invited and texts nobody', async () => {
      const { familyId } = await seedHousehold();
      await unclearRow(familyId);
      posts.length = 0;

      const again = await parentSays(lane.add);

      expect(again).toEqual(lane.alreadyInvited);
      expect(postsToPerson()).toHaveLength(0);
      expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
    });
  });

  it('a redelivered yes after an unclear failure posts nothing more', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    posts.length = 0;
    timeouts = ['/chats'];
    const yes = {
      from: PARENT_PHONE,
      body: 'yes',
      providerId: `in-parent-redelivered-${lane.lane}`,
      receivedAt: NOW,
      transport: 'imessage' as const,
      chatId: PARENT_CHAT,
    };
    await handleInboundSms(db.database, yes, iMessageDeps(PARENT_CHAT));
    expect(postsToPerson()).toHaveLength(1);

    const redelivered = await handleInboundSms(db.database, yes, iMessageDeps(PARENT_CHAT));

    expect(redelivered.status).toBe('ignored');

    expect(postsToPerson()).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });

  it('names a page that did not leave, on the outcome and the audit row', async () => {
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    timeouts = ['/chats'];
    opsStatus = 500;

    const failed = await parentSays('yes');

    expect(failed).toEqual({ status: lane.unsent, opsPage: 'page_failed' });
    const [audit] = await failureAudit((await inviteRow(familyId)).id);
    expect(audit?.after).toMatchObject({ why: 'unclear', opsPage: 'page_failed' });
  });
});

describe('flag on: the seat', () => {
  it('the co-parent seating claim refuses a row not waiting on the person', async () => {
    const { familyId, parentUserId } = await seedHousehold();
    await parentSays(ADD_CO_PARENT);
    const row = await inviteRow(familyId);
    expect(row.state).toBe('awaiting_parent_assent');
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

  it('the caregiver seating claim refuses a row not waiting on the person', async () => {
    const { familyId, parentUserId } = await seedHousehold();
    await parentSays(ADD_CAREGIVER);
    const row = await inviteRow(familyId);
    expect(row.state).toBe('awaiting_parent_assent');
    const invite: CaregiverLaneInvite = {
      id: row.id,
      familyId,
      invitedByUserId: parentUserId,
      displayName: 'grandma',
      phoneE164: PERSON_PHONE,
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      role: 'grandparent',
    };

    await expect(
      acceptInvite(db.database, { invite, verbatimReply: 'yes', now: NOW }),
    ).rejects.toBeInstanceOf(InviteNotAwaitingReply);

    expect(await seatsFor(familyId, 'grandparent')).toBe(0);
    expect((await inviteRow(familyId)).closedAt).toBeNull();
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

  it("a clean send goes to the person's number under the row's key and acks", async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);

    const sent = await numberTurn(seeded);

    expect(sent).toMatchObject({ status: 'sent', reply: expect.stringContaining('Sam') });
    const row = await inviteRow(seeded.familyId);
    expect(row.state).toBe('awaiting_caregiver_reply');
    expect(postsToPerson().map((post) => post.key)).toEqual([linqKey('co_parent', row.id)]);
    expect(postsIntoParentChat()).toHaveLength(0);
  });

  it('a certain refusal closes the row, pages, sends no ack, and the number can be sent again', async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);
    linqStatuses = [400];

    const failed = await numberTurn(seeded);

    expect(failed).toEqual({ status: 'invite_unsent', reply: null, opsPage: 'paged' });
    const first = await inviteRow(seeded.familyId);
    expect(first.state).toBe('expired_unsent');
    expectPagedOnce('refused');
    posts.length = 0;

    const again = await numberTurn(seeded);

    expect(again.status).toBe('sent');
    const second = await newestRowId(seeded.familyId, first.id);
    expect(postsToPerson().map((post) => post.key)).toEqual([linqKey('co_parent', second)]);
  });

  it('an unclear failure leaves the row, sends no ack, and a repeat texts nobody', async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);
    timeouts = ['/chats'];

    const failed = await numberTurn(seeded);

    expect(failed).toEqual({ status: 'invite_unsent', reply: null, opsPage: 'paged' });
    expect((await inviteRow(seeded.familyId)).state).toBe('awaiting_caregiver_reply');
    expectPagedOnce('unclear');
    posts.length = 0;

    const repeat = await numberTurn(seeded);

    expect(repeat.status).toBe('refused');
    expect(postsToPerson()).toHaveLength(0);
    expect((await inviteRow(seeded.familyId)).state).toBe('awaiting_caregiver_reply');
  });

  it("the person's yes on an unclear row seats them", async () => {
    const seeded = await seedHousehold();
    await seedAsk(seeded);
    timeouts = ['/chats'];
    await numberTurn(seeded);

    const outcome = await personSays('yes');

    expect(outcome.status).toBe('co_parent_accepted');
    expect(await seatsFor(seeded.familyId, 'co_parent')).toBe(1);
  });
});

describe.each(LANES)('flag off: $lane', (lane) => {
  it.each([
    ['unset', undefined],
    ['not exactly true', 'TRUE'],
  ])("keeps main's route when %s: the invite goes into the turn's chat", async (_name, value) => {
    vi.stubEnv(FLAG, value as string);
    const { familyId } = await seedHousehold();
    await parentSays(lane.add);
    posts.length = 0;

    const outcome = await parentSays('yes');

    expect(outcome.status).toBe(lane.sent);
    expect(postsToPerson()).toHaveLength(0);
    expect(postsIntoParentChat()).toHaveLength(2);
    expect((await inviteRow(familyId)).state).toBe('awaiting_caregiver_reply');
  });
});
