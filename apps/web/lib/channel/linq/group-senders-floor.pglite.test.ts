import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeDutyWrite } from '~/lib/channel/coparent/duty/ack';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from '~/lib/channel/coparent/duty/flag';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { createSession } from '~/lib/channel/intake/session';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { PostgresRateLimiter } from '~/lib/rate-limit/postgres';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type FloorPass,
  FloorPassRefused,
  chatFloorAllows,
  sendFlooredChatMessage,
  sendFlooredPoll,
} from './group-audience';
import { runGroupPlanFollowups } from './group-plan-rsvp/followups';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './group-plan-rsvp/memory-store';
import {
  GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
  GROUP_PLAN_RSVP_TEMPLATE,
  GroupPlanRsvpHeld,
  sendGroupPlanRsvpLine,
} from './group-plan-rsvp/send';
import { fakeGroupPlanRsvpComposer } from './group-plan-rsvp/voice-fake';
import { handleLinqInboundRequest } from './inbound';
import { sendChoicePoll } from './poll';
import { listLinqParticipantHandles } from './transport';

/**
 * VIL-399 follow-up: the duty restatement, the choice poll and the RSVP tally reach a
 * family group only through the family-chat floor, with the production live read of who
 * is in the chat now (Linq's GET /chats/:id, here answered by the wire below).
 *
 * The roster is confirmed: one known parent and a confirmed co-parent. Hale cannot
 * identify an Apple-ID email in the chat, so a household line there holds.
 *
 * A send skips the floor only in a chat that is provably the recipient's own 1:1: Linq
 * said `is_group: false` on that recipient's inbound there (`channel_messages.in_group`).
 * A chat with no household rows, or a caller's own label, is not proof.
 *
 * No model is scripted (hard rule #8): the duty writer gets no client, so a restatement
 * the floor lets through stops at the writer (`model_unsent`) with nothing sent, which is
 * what shows the floor passed it.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const GROUP = 'chat-household-floor';
const UNCLAIMED = 'chat-unclaimed-floor';
const DIRECT = 'chat-direct-floor';
const HALE = '+15555550100';
const MOM = '+15555550121';
const DAD = '+15555550122';
const EMAIL = 'someone@example.com';
const DAY = new Date('2026-10-28T18:00:00.000Z');
const ZONE = 'America/Vancouver';
const BASE = 'https://api.linqapp.com/api/partner/v3';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('LINQ_POLLS', 'on');
  vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec(
    'truncate table families, users, linq_group_rosters, channel_messages, linq_poll_options, sms_intake_sessions, rate_limits cascade',
  );
});

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** Linq as the docs answer it. `present` is the GET's participant list; null refuses the read. */
function linqWire(present: string[] | null) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url: String(url), body });
    if (method === 'GET') {
      if (!present) return Response.json({ error: 'unavailable' }, { status: 500 });
      return Response.json({
        chat: {
          id: GROUP,
          is_group: true,
          handles: [
            { handle: HALE, is_me: true },
            ...present.map((handle) => ({ handle, is_me: false })),
          ],
        },
      });
    }
    const poll = body?.poll as { options?: { text?: string }[] } | undefined;
    if (poll?.options) {
      return Response.json(
        {
          message_id: 'poll-1',
          poll: {
            options: poll.options.map((option, index) => ({
              option_id: `opt-${index}`,
              text: option.text,
            })),
          },
        },
        { status: 202 },
      );
    }
    return Response.json({ message: { id: `out-${calls.length}` } }, { status: 201 });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    reads: () => calls.filter((c) => c.method === 'GET'),
    groupPosts: () =>
      calls.filter((c) => c.method === 'POST' && c.url.startsWith(`${BASE}/chats/${GROUP}/`)),
    posts: () => calls.filter((c) => c.method === 'POST'),
  };
}

/** The family holds GROUP; its confirmed roster is the two parents' phones. */
async function householdGroup(): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Floor family');
  await db.database
    .update(schema.families)
    .set({ linqGroupChatId: GROUP })
    .where(eq(schema.families.id, seeded.familyId));
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({
      chatId: GROUP,
      familyId: seeded.familyId,
      source: 'added_to_existing',
      status: 'confirmed',
    })
    .returning({ id: schema.linqGroupRosters.id });
  await db.database.insert(schema.linqGroupRosterMembers).values([
    {
      rosterId: roster?.id as string,
      chatId: GROUP,
      phoneE164Hash: phoneBlindIndex(MOM),
      status: 'known_parent',
    },
    {
      rosterId: roster?.id as string,
      chatId: GROUP,
      phoneE164Hash: phoneBlindIndex(DAD),
      status: 'confirmed',
      confirmedRole: 'co_parent',
    },
  ]);
  return seeded;
}

/** What the Linq webhook door writes for a parent's text: `in_group` is Linq's `is_group`. */
async function recordInbound(
  sender: { familyId: string; parentUserId: string },
  chatId: string,
  inGroup: boolean | null,
  turn = 1,
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: sender.familyId,
    parentUserId: sender.parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerMessageId: `in-${chatId}-${sender.parentUserId}-${turn}`,
    providerChatId: chatId,
    status: 'delivered',
    inGroup,
  });
}

function dutyInput(
  seeded: { familyId: string; parentUserId: string },
  inboundChatId: string,
  wire: ReturnType<typeof linqWire>,
) {
  return {
    database: db.database,
    familyId: seeded.familyId,
    actorUserId: seeded.parentUserId,
    source: 'llm' as const,
    now: DAY,
    timeZone: ZONE,
    inboundChatId,
    inboundMessageId: 'in-1',
    language: 'en' as const,
    name: 'Sam',
    kid: 'Robin',
    event: 'swim',
    day: 'Saturday',
    time: '3:00pm',
    fetch: wire.fetch,
    replyClient: null,
  };
}

async function ledger(templateKey: string) {
  return db.database
    .select({ status: schema.channelMessages.status, chat: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.templateKey, templateKey));
}

describe('duty restatement in a family group goes through the floor', () => {
  it('an Apple-ID email in the chat: no restatement, a tapback, the floor reason named', async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, GROUP, true);
    const wire = linqWire([MOM, DAD, EMAIL]);

    const ack = await acknowledgeDutyWrite(dutyInput(seeded, GROUP, wire));

    expect(ack).toEqual({
      status: 'audience_held',
      reason: 'participant_unresolved',
      tapback: true,
      sent: false,
      text: null,
    });
    expect(wire.groupPosts()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([`${BASE}/messages/in-1/reactions`]);
    expect(await ledger('linq:duty_restate')).toEqual([]);
    expect(await ledger('linq:duty_tapback')).toHaveLength(1);
  });

  it("a caller that labels the group chat 'reply' cannot skip the floor", async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    const labelled = {
      ...dutyInput(seeded, GROUP, wire),
      surface: 'reply',
    } as Parameters<typeof acknowledgeDutyWrite>[0];

    const ack = await acknowledgeDutyWrite(labelled);

    expect(ack).toMatchObject({ status: 'audience_held', reason: 'participant_unresolved' });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.groupPosts()).toEqual([]);
  });

  it('a failed live read (participants_unverified) sends no restatement into the group', async () => {
    const seeded = await householdGroup();
    const wire = linqWire(null);

    const ack = await acknowledgeDutyWrite(dutyInput(seeded, GROUP, wire));

    expect(ack).toMatchObject({ status: 'audience_held', reason: 'participants_unverified' });
    expect(wire.reads()).toHaveLength(1);
    expect(wire.groupPosts()).toEqual([]);
  });

  it('positive control: the live list is exactly the roster, so the floor passes it to the writer', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD]);

    const ack = await acknowledgeDutyWrite(dutyInput(seeded, GROUP, wire));

    expect(ack).toMatchObject({ status: 'skipped', reason: 'model_unsent' });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.posts()).toEqual([]);
  });

  it("positive control: the parent's recorded 1:1 chat reads no participants", async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, DIRECT, false);
    const wire = linqWire([MOM, DAD, EMAIL]);

    const ack = await acknowledgeDutyWrite(dutyInput(seeded, DIRECT, wire));

    expect(ack).toMatchObject({ status: 'skipped', reason: 'model_unsent' });
    expect(wire.reads()).toEqual([]);
  });
});

describe('a choice poll in a family group goes through the floor', () => {
  const poll = (
    seeded: { familyId: string; parentUserId: string },
    chatId: string,
    f: typeof fetch,
  ) =>
    sendChoicePoll(db.database, {
      chatId,
      prompt: 'Saturday or Sunday?',
      options: [{ text: 'Saturday' }, { text: 'Sunday' }],
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: DAY,
      fetch: f,
      idempotencyKey: `poll:floor:${chatId}`,
    });

  it('an Apple-ID email in the chat: neither the question nor the poll is sent', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);

    await expect(poll(seeded, GROUP, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'participant_unresolved',
    });
    expect(wire.posts()).toEqual([]);
    expect(await db.database.select().from(schema.linqPollOptions)).toEqual([]);
    expect(await ledger('linq:poll')).toEqual([]);
  });

  it('positive control: the live list is exactly the roster, so the question and poll go', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD]);

    const sent = await poll(seeded, GROUP, wire.fetch);

    expect(sent.status).toBe('sent');
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.groupPosts()).toHaveLength(2);
    expect(await ledger('linq:poll')).toEqual([{ status: 'sent', chat: GROUP }]);
  });

  it('a group chat with no roster and no family holder is held, not read as a 1:1', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);

    await expect(poll(seeded, UNCLAIMED, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'group_roles_unconfirmed',
    });
    expect(wire.posts()).toEqual([]);
    expect(await db.database.select().from(schema.linqPollOptions)).toEqual([]);
    expect(await ledger('linq:poll')).toEqual([]);
  });

  it("another parent's recorded 1:1 is not this recipient's: held", async () => {
    const seeded = await householdGroup();
    const other = await seedFamily(db.database, 'Other family');
    await recordInbound(other, DIRECT, false);
    const wire = linqWire([MOM, DAD, EMAIL]);

    await expect(poll(seeded, DIRECT, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'group_roles_unconfirmed',
    });
    expect(wire.posts()).toEqual([]);
  });

  it("positive control: the recipient's recorded 1:1 chat sends with no floor read", async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, DIRECT, false);
    const wire = linqWire([MOM, DAD, EMAIL]);

    const sent = await poll(seeded, DIRECT, wire.fetch);

    expect(sent.status).toBe('sent');
    expect(wire.reads()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([
      `${BASE}/chats/${DIRECT}/messages`,
      `${BASE}/chats/${DIRECT}/polls`,
    ]);
  });

  it('a chat where Linq once said is_group false and later true is a group: the floor reads it', async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, GROUP, false, 1);
    await recordInbound(seeded, GROUP, true, 2);
    const wire = linqWire([MOM, DAD, EMAIL]);

    await expect(poll(seeded, GROUP, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'participant_unresolved',
    });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.posts()).toEqual([]);
  });

  it('positive control: an intake turn with no is_group beside a 1:1 turn still sends as a 1:1', async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, DIRECT, null, 1);
    await recordInbound(seeded, DIRECT, false, 2);
    const wire = linqWire([MOM, DAD, EMAIL]);

    const sent = await poll(seeded, DIRECT, wire.fetch);

    expect(sent.status).toBe('sent');
    expect(wire.reads()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([
      `${BASE}/chats/${DIRECT}/messages`,
      `${BASE}/chats/${DIRECT}/polls`,
    ]);
  });
});

describe('a floored send needs the pass the floor gave for that chat and that class', () => {
  const floor = (
    recipientUserId: string,
    chatId: string,
    wire: ReturnType<typeof linqWire>,
    lineClass: Parameters<typeof chatFloorAllows>[1]['lineClass'] = 'event_logistics',
  ) =>
    chatFloorAllows(db.database, {
      chatId,
      recipientUserId,
      lineClass,
      listChatHandles: (i) => listLinqParticipantHandles({ ...i, fetch: wire.fetch }),
    });

  const refusalOf = (sent: Promise<unknown>) =>
    sent.then(
      () => null,
      (err: unknown) => err,
    );

  it('a pass made by a cast is refused and nothing is posted', async () => {
    const wire = linqWire([MOM, DAD]);
    const forged = { chatId: GROUP, lineClass: 'event_logistics' } as unknown as FloorPass;

    const refusal = await refusalOf(
      sendFlooredChatMessage(forged, 'event_logistics', {
        chatId: GROUP,
        text: 'x',
        fetch: wire.fetch,
      }),
    );

    expect(refusal).toBeInstanceOf(FloorPassRefused);
    expect((refusal as FloorPassRefused).reason).toBe('pass_forged');
    expect(wire.posts()).toEqual([]);
  });

  it("the pass for the recipient's 1:1 does not send into another chat", async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, DIRECT, false);
    const wire = linqWire([MOM, DAD, EMAIL]);
    const verdict = await floor(seeded.parentUserId, DIRECT, wire);
    if (!verdict.allowed) throw new Error(`expected a pass, got ${verdict.reason}`);

    const refusal = await refusalOf(
      sendFlooredChatMessage(verdict.pass, 'event_logistics', {
        chatId: GROUP,
        text: 'x',
        fetch: wire.fetch,
      }),
    );

    expect(refusal).toBeInstanceOf(FloorPassRefused);
    expect((refusal as FloorPassRefused).reason).toBe('pass_wrong_chat');
    expect(wire.posts()).toEqual([]);
  });

  it('positive control: the same pass sends into the chat it was given for', async () => {
    const seeded = await householdGroup();
    await recordInbound(seeded, DIRECT, false);
    const wire = linqWire([MOM, DAD, EMAIL]);
    const verdict = await floor(seeded.parentUserId, DIRECT, wire);
    if (!verdict.allowed) throw new Error(`expected a pass, got ${verdict.reason}`);

    await sendFlooredChatMessage(verdict.pass, 'event_logistics', {
      chatId: DIRECT,
      text: 'x',
      fetch: wire.fetch,
    });
    expect(wire.posts().map((c) => c.url)).toEqual([`${BASE}/chats/${DIRECT}/messages`]);
  });

  it("a 'reply' pass from an unclaimed group cannot carry a pickup_duty line", async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    const verdict = await floor(seeded.parentUserId, UNCLAIMED, wire, 'reply');
    if (!verdict.allowed) throw new Error(`expected a reply pass, got ${verdict.reason}`);

    const refusal = await refusalOf(
      sendFlooredChatMessage(verdict.pass, 'pickup_duty', {
        chatId: UNCLAIMED,
        text: 'x',
        fetch: wire.fetch,
      }),
    );

    expect(refusal).toBeInstanceOf(FloorPassRefused);
    expect((refusal as FloorPassRefused).reason).toBe('pass_wrong_class');
    expect(wire.posts()).toEqual([]);
  });

  it("a 'reply' pass copied with a household class written in is refused as forged", async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    const verdict = await floor(seeded.parentUserId, UNCLAIMED, wire, 'reply');
    if (!verdict.allowed) throw new Error(`expected a reply pass, got ${verdict.reason}`);
    const relabelled: FloorPass = { ...verdict.pass, lineClass: 'pickup_duty' };

    const refusal = await refusalOf(
      sendFlooredChatMessage(relabelled, 'pickup_duty', {
        chatId: UNCLAIMED,
        text: 'x',
        fetch: wire.fetch,
      }),
    );

    expect(refusal).toBeInstanceOf(FloorPassRefused);
    expect((refusal as FloorPassRefused).reason).toBe('pass_forged');
    expect(wire.posts()).toEqual([]);
  });

  it("a 'reply' pass cannot carry the poll of a household choice either", async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    const verdict = await floor(seeded.parentUserId, UNCLAIMED, wire, 'reply');
    if (!verdict.allowed) throw new Error(`expected a reply pass, got ${verdict.reason}`);

    const refusal = await refusalOf(
      sendFlooredPoll(verdict.pass, 'event_logistics', {
        chatId: UNCLAIMED,
        options: ['Saturday', 'Sunday'],
        idempotencyKey: 'poll:reply-pass',
        fetch: wire.fetch,
      }),
    );

    expect(refusal).toBeInstanceOf(FloorPassRefused);
    expect((refusal as FloorPassRefused).reason).toBe('pass_wrong_class');
    expect(wire.posts()).toEqual([]);
  });

  it("positive control: a 'pickup_duty' pass for the household group sends the duty line", async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD]);
    const verdict = await floor(seeded.parentUserId, GROUP, wire, 'pickup_duty');
    if (!verdict.allowed) throw new Error(`expected a duty pass, got ${verdict.reason}`);

    await sendFlooredChatMessage(verdict.pass, 'pickup_duty', {
      chatId: GROUP,
      text: 'x',
      fetch: wire.fetch,
    });
    expect(wire.posts().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}/messages`]);
  });
});

describe('the RSVP tally goes through the floor', () => {
  const tally = (familyId: string) =>
    sendGroupPlanRsvpLine(db.database, {
      chatId: GROUP,
      familyId,
      text: 'Two in, one to go.',
      templateKey: GROUP_PLAN_RSVP_TEMPLATE,
      now: DAY,
    });

  it('an Apple-ID email in the chat: nothing is sent or ledgered, the reason is named', async () => {
    const { familyId } = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    vi.stubGlobal('fetch', wire.fetch);

    const refusal = await tally(familyId).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(GroupPlanRsvpHeld);
    expect((refusal as GroupPlanRsvpHeld).reason).toBe('participant_unresolved');
    expect(wire.reads()).toHaveLength(1);
    expect(wire.posts()).toEqual([]);
    expect(await ledger(GROUP_PLAN_RSVP_TEMPLATE)).toEqual([]);
  });

  it('positive control: the live list is exactly the roster, so the tally goes', async () => {
    const { familyId } = await householdGroup();
    const wire = linqWire([MOM, DAD]);
    vi.stubGlobal('fetch', wire.fetch);

    await expect(tally(familyId)).resolves.toEqual({ providerMessageId: 'out-2' });
    expect(wire.groupPosts().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}/messages`]);
    expect(await ledger(GROUP_PLAN_RSVP_TEMPLATE)).toEqual([{ status: 'sent', chat: GROUP }]);
  });
});

describe('RSVP follow-ups through the real sender', () => {
  async function duePlan(familyId: string) {
    const world = createMemoryWorld();
    world.families.set(GROUP, { familyId, timeZone: ZONE });
    const store = createMemoryGroupPlanRsvpStore(world);
    const plan = await store.createPlan({
      chatId: GROUP,
      familyId,
      title: 'park Saturday',
      startsAt: new Date('2026-11-01T18:00:00.000Z'),
      location: null,
      rsvpDeadlineAt: new Date('2026-10-27T18:00:00.000Z'),
      createdByUserId: null,
      expected: [
        { memberKey: 'k-a', displayName: 'Ari', userId: null, haleCustomer: false },
        { memberKey: 'k-b', displayName: 'Bo', userId: null, haleCustomer: false },
      ],
      now: DAY,
    });
    return { store, plan };
  }

  function run(store: ReturnType<typeof createMemoryGroupPlanRsvpStore>) {
    return runGroupPlanFollowups(
      {
        store,
        composer: fakeGroupPlanRsvpComposer(),
        send: ({ chatId, text, familyId, planId }) =>
          sendGroupPlanRsvpLine(db.database, {
            chatId,
            familyId,
            planId,
            text,
            templateKey: GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
            now: DAY,
          }),
        enabled: () => true,
      },
      DAY,
    );
  }

  it('participants_unverified holds the wave without consuming it', async () => {
    const { familyId } = await householdGroup();
    const { store, plan } = await duePlan(familyId);
    vi.stubGlobal('fetch', linqWire(null).fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(true);
  });

  /** Every GET answers `status` with `body`; nothing else may reach the wire. */
  function readRefusedWith(status: number, body: unknown) {
    const posts: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return Response.json(body, { status });
      posts.push(String(url));
      return Response.json({ message: { id: 'out-1' } }, { status: 201 });
    });
    return { fetch: fetchImpl as unknown as typeof fetch, posts: () => posts };
  }

  it('a read Linq refuses for this chat (404, its 2001) holds the wave and keeps it claimed', async () => {
    const { familyId } = await householdGroup();
    const { store, plan } = await duePlan(familyId);
    const wire = readRefusedWith(404, { error: { code: 2001 } });
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(wire.posts()).toEqual([]);
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(false);
  });

  it('positive control: a 404 with no Linq code holds the wave without consuming it', async () => {
    const { familyId } = await householdGroup();
    const { store, plan } = await duePlan(familyId);
    const wire = readRefusedWith(404, {});
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(wire.posts()).toEqual([]);
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(true);
  });

  it('participant_unresolved holds the wave and keeps it claimed', async () => {
    const { familyId } = await householdGroup();
    const { store, plan } = await duePlan(familyId);
    const wire = linqWire([MOM, DAD, EMAIL]);
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(wire.posts()).toEqual([]);
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(false);
  });

  it('positive control: the live list is exactly the roster, so the follow-up goes', async () => {
    const { familyId } = await householdGroup();
    const { store } = await duePlan(familyId);
    const wire = linqWire([MOM, DAD]);
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 1, held: 0, failed: 0 });
    expect(wire.groupPosts()).toHaveLength(1);
  });
});

describe('only Linq’s own is_group can make a chat 1:1', () => {
  const SECRET_BYTES = Buffer.alloc(32, 9);
  const TS = String(Math.floor(DAY.getTime() / 1000));

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', SECRET_BYTES)
      .update(`evt_floor.${TS}.${raw}`)
      .digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_floor',
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    });
  }

  /** A location share carries no is_group: Linq does not say what kind of chat it is in. */
  function locationShare(chatId: string) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'location.sharing.started',
      event_id: 'evt_floor',
      created_at: DAY.toISOString(),
      data: { chat_id: chatId, shared_by: MOM, began_at: DAY.toISOString() },
    };
  }

  function directText(chatId: string) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_floor',
      created_at: DAY.toISOString(),
      data: {
        chat: { id: chatId, is_group: false },
        id: 'in-direct-text',
        direction: 'inbound',
        sender_handle: { handle: MOM, is_me: false },
        parts: [{ type: 'text', value: 'is swim still on' }],
        sent_at: DAY.toISOString(),
        service: 'iMessage',
      },
    };
  }

  /** MOM is the household's verified parent, so a turn the intake does not keep reaches the coach. */
  async function verifiedMom(seeded: { familyId: string; parentUserId: string }): Promise<void> {
    await db.database.insert(schema.parentChannels).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(MOM),
      phoneE164Hash: phoneBlindIndex(MOM),
      verifiedAt: DAY,
    });
  }

  function door(readSharedLocality: () => Promise<{ status: 'locality'; locality: string }>) {
    const outcomes: string[] = [];
    const intake: IntakeDeps = {
      transport: new FakeTransport(),
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      optOutReader: { read: async () => ({ intent: 'none', confirmation: '' }) },
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new PostgresRateLimiter(db.database),
      now: DAY,
    };
    const deps = {
      database: db.database,
      intake: () => intake,
      enqueue: async () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async (outcome: string) => {
        outcomes.push(outcome);
      },
      now: () => DAY,
      markRead: async () => ({ status: 'sent' }),
      readSharedLocality,
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
    return { deps, outcomes };
  }

  async function inboundInGroup(chatId: string) {
    return db.database
      .select({ inGroup: schema.channelMessages.inGroup })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.providerChatId, chatId),
          eq(schema.channelMessages.direction, 'in'),
        ),
      );
  }

  const poll = (
    seeded: { familyId: string; parentUserId: string },
    chatId: string,
    f: typeof fetch,
  ) =>
    sendChoicePoll(db.database, {
      chatId,
      prompt: 'Saturday or Sunday?',
      options: [{ text: 'Saturday' }, { text: 'Sunday' }],
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: DAY,
      fetch: f,
      idempotencyKey: `poll:door:${chatId}`,
    });

  beforeEach(() => {
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  it('a location share in the family group records no group bit, so a later poll there is floored', async () => {
    const seeded = await householdGroup();
    await verifiedMom(seeded);
    // The place ask is open when the share lands; the parent's other text closes the
    // session while the locality is read, so the share is handed to the coach.
    await createSession(db.database, { phoneE164: MOM, state: 'awaiting_place', sourceCode: null });
    vi.stubGlobal('fetch', linqWire([MOM, DAD]).fetch);
    const { deps } = door(async () => {
      await db.database
        .update(schema.smsIntakeSessions)
        .set({ closedAt: DAY })
        .where(eq(schema.smsIntakeSessions.phoneHash, phoneBlindIndex(MOM)));
      return { status: 'locality', locality: 'Springfield' };
    });

    const shared = await handleLinqInboundRequest(signed(locationShare(GROUP)), deps);
    await expect(shared.json()).resolves.toEqual({ outcome: 'handed_off' });

    const wire = linqWire([MOM, DAD, EMAIL]);
    await expect(poll(seeded, GROUP, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'participant_unresolved',
    });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.posts()).toEqual([]);
    expect(await inboundInGroup(GROUP)).toEqual([{ inGroup: null }]);
  });

  it("a poll 'none' vote in the family group records no group bit, so a later poll there is floored", async () => {
    const seeded = await householdGroup();
    await verifiedMom(seeded);
    await db.database.insert(schema.linqPollOptions).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      providerChatId: GROUP,
      providerMessageId: 'poll-msg-none',
      optionId: 'opt-none-floor',
      optionText: 'None of these',
      choiceKind: 'none',
    });
    const { deps } = door(async () => ({ status: 'locality', locality: 'Springfield' }));
    // A vote carries no is_group: Linq does not say what kind of chat it is in.
    const vote = {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'poll.vote.added',
      event_id: 'evt_floor',
      created_at: DAY.toISOString(),
      data: {
        chat_id: GROUP,
        message_id: 'poll-msg-none',
        option_id: 'opt-none-floor',
        sender_handle: { handle: MOM, is_me: false },
      },
    };

    const voted = await handleLinqInboundRequest(signed(vote), deps);
    await expect(voted.json()).resolves.toEqual({ outcome: 'poll_none' });

    const wire = linqWire([MOM, DAD, EMAIL]);
    await expect(poll(seeded, GROUP, wire.fetch)).resolves.toEqual({
      status: 'held',
      reason: 'participant_unresolved',
    });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.posts()).toEqual([]);
    expect(await inboundInGroup(GROUP)).toEqual([{ inGroup: null }]);
  });

  it('positive control: a real 1:1 text (Linq said is_group false) still sends the poll with no floor read', async () => {
    const seeded = await householdGroup();
    await verifiedMom(seeded);
    vi.stubGlobal('fetch', linqWire([MOM, DAD]).fetch);
    const { deps } = door(async () => ({ status: 'locality', locality: 'Springfield' }));

    const texted = await handleLinqInboundRequest(signed(directText(DIRECT)), deps);
    await expect(texted.json()).resolves.toEqual({ outcome: 'handed_off' });
    expect(await inboundInGroup(DIRECT)).toEqual([{ inGroup: false }]);

    const wire = linqWire([MOM, DAD, EMAIL]);
    const sent = await poll(seeded, DIRECT, wire.fetch);

    expect(sent.status).toBe('sent');
    expect(wire.reads()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([
      `${BASE}/chats/${DIRECT}/messages`,
      `${BASE}/chats/${DIRECT}/polls`,
    ]);
  });
});
