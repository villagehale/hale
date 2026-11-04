import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeDutyWrite } from '~/lib/channel/coparent/duty/ack';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from '~/lib/channel/coparent/duty/flag';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { runGroupPlanFollowups } from './group-plan-rsvp/followups';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './group-plan-rsvp/memory-store';
import {
  GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
  GROUP_PLAN_RSVP_TEMPLATE,
  GroupPlanRsvpHeld,
  sendGroupPlanRsvpLine,
} from './group-plan-rsvp/send';
import { fakeGroupPlanRsvpComposer } from './group-plan-rsvp/voice-fake';
import { sendChoicePoll } from './poll';

/**
 * VIL-399 follow-up: the duty restatement, the choice poll and the RSVP tally reach a
 * family group only through the family-chat floor, with the production live read of who
 * is in the chat now (Linq's GET /chats/:id, here answered by the wire below).
 *
 * The roster is confirmed: one known parent and a confirmed co-parent. Hale cannot
 * identify an Apple-ID email in the chat, so a household line there holds.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const GROUP = 'chat-household-floor';
const DIRECT = 'chat-direct-floor';
const HALE = '+15555550100';
const MOM = '+15555550121';
const DAD = '+15555550122';
const EMAIL = 'someone@example.com';
const DAY = new Date('2026-10-28T18:00:00.000Z');
const ZONE = 'America/Vancouver';
const BASE = 'https://api.linqapp.com/api/partner/v3';
const RESTATE = "Sam has Robin's swim on Saturday at 3:00pm. Say so here if that changes.";

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
    'truncate table families, users, linq_group_rosters, channel_messages, linq_poll_options cascade',
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

function scriptedRestate(): AgentClient & { calls: () => number } {
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify({ text: RESTATE }) }],
    usage: { input_tokens: 12, output_tokens: 8 },
    stop_reason: 'end_turn',
  }));
  return {
    messages: { create },
    calls: () => create.mock.calls.length,
  } as unknown as AgentClient & { calls: () => number };
}

function dutyInput(
  seeded: { familyId: string; parentUserId: string },
  chat: { inboundChatId: string; surface: 'group' | 'reply' },
  wire: ReturnType<typeof linqWire>,
  replyClient: AgentClient,
) {
  return {
    database: db.database,
    familyId: seeded.familyId,
    actorUserId: seeded.parentUserId,
    source: 'llm' as const,
    now: DAY,
    timeZone: ZONE,
    inboundChatId: chat.inboundChatId,
    inboundMessageId: 'in-1',
    surface: chat.surface,
    language: 'en' as const,
    name: 'Sam',
    kid: 'Robin',
    event: 'swim',
    day: 'Saturday',
    time: '3:00pm',
    fetch: wire.fetch,
    replyClient,
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
    const wire = linqWire([MOM, DAD, EMAIL]);
    const model = scriptedRestate();

    const ack = await acknowledgeDutyWrite(
      dutyInput(seeded, { inboundChatId: GROUP, surface: 'group' }, wire, model),
    );

    expect(ack).toEqual({
      status: 'audience_held',
      reason: 'participant_unresolved',
      tapback: true,
      sent: false,
      text: null,
    });
    expect(wire.groupPosts()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([`${BASE}/messages/in-1/reactions`]);
    expect(model.calls()).toBe(0);
    expect(await ledger('linq:duty_restate')).toEqual([]);
    expect(await ledger('linq:duty_tapback')).toHaveLength(1);
  });

  it('a failed live read (participants_unverified) sends no restatement into the group', async () => {
    const seeded = await householdGroup();
    const wire = linqWire(null);
    const model = scriptedRestate();

    const ack = await acknowledgeDutyWrite(
      dutyInput(seeded, { inboundChatId: GROUP, surface: 'group' }, wire, model),
    );

    expect(ack).toMatchObject({ status: 'audience_held', reason: 'participants_unverified' });
    expect(wire.reads()).toHaveLength(1);
    expect(wire.groupPosts()).toEqual([]);
    expect(model.calls()).toBe(0);
  });

  it('positive control: the live list is exactly the roster, so the restatement goes', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD]);

    const ack = await acknowledgeDutyWrite(
      dutyInput(seeded, { inboundChatId: GROUP, surface: 'group' }, wire, scriptedRestate()),
    );

    expect(ack).toEqual({ status: 'restated', sent: true, text: RESTATE });
    expect(wire.reads().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}`]);
    expect(wire.groupPosts().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}/messages`]);
  });

  it('positive control: a 1:1 duty ack is unchanged and reads no participants', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);

    const ack = await acknowledgeDutyWrite(
      dutyInput(seeded, { inboundChatId: DIRECT, surface: 'reply' }, wire, scriptedRestate()),
    );

    expect(ack).toEqual({ status: 'restated', sent: true, text: RESTATE });
    expect(wire.reads()).toEqual([]);
    expect(wire.posts().map((c) => c.url)).toEqual([`${BASE}/chats/${DIRECT}/messages`]);
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

  it('positive control: a 1:1 chat no family holds and no roster seats is unchanged', async () => {
    const seeded = await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);

    const sent = await poll(seeded, DIRECT, wire.fetch);

    expect(sent.status).toBe('sent');
    expect(wire.reads()).toEqual([]);
    expect(wire.posts()).toHaveLength(2);
  });
});

describe('the RSVP tally goes through the floor', () => {
  const tally = () =>
    sendGroupPlanRsvpLine(db.database, {
      chatId: GROUP,
      text: 'Two in, one to go.',
      templateKey: GROUP_PLAN_RSVP_TEMPLATE,
      now: DAY,
    });

  it('an Apple-ID email in the chat: nothing is sent or ledgered, the reason is named', async () => {
    await householdGroup();
    const wire = linqWire([MOM, DAD, EMAIL]);
    vi.stubGlobal('fetch', wire.fetch);

    const refusal = await tally().then(
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
    await householdGroup();
    const wire = linqWire([MOM, DAD]);
    vi.stubGlobal('fetch', wire.fetch);

    await expect(tally()).resolves.toEqual({ providerMessageId: 'out-2' });
    expect(wire.groupPosts().map((c) => c.url)).toEqual([`${BASE}/chats/${GROUP}/messages`]);
    expect(await ledger(GROUP_PLAN_RSVP_TEMPLATE)).toEqual([{ status: 'sent', chat: GROUP }]);
  });
});

describe('RSVP follow-ups through the real sender', () => {
  async function duePlan() {
    const world = createMemoryWorld();
    world.families.set(GROUP, { familyId: 'memory-family', timeZone: ZONE });
    const store = createMemoryGroupPlanRsvpStore(world);
    const plan = await store.createPlan({
      chatId: GROUP,
      familyId: 'memory-family',
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
        send: ({ chatId, text }) =>
          sendGroupPlanRsvpLine(db.database, {
            chatId,
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
    await householdGroup();
    const { store, plan } = await duePlan();
    vi.stubGlobal('fetch', linqWire(null).fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(true);
  });

  it('participant_unresolved holds the wave and keeps it claimed', async () => {
    await householdGroup();
    const { store, plan } = await duePlan();
    const wire = linqWire([MOM, DAD, EMAIL]);
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, held: 1, failed: 0 });
    expect(wire.posts()).toEqual([]);
    expect(await store.claimFollowup(plan.id, 1, DAY)).toBe(false);
  });

  it('positive control: the live list is exactly the roster, so the follow-up goes', async () => {
    await householdGroup();
    const { store } = await duePlan();
    const wire = linqWire([MOM, DAD]);
    vi.stubGlobal('fetch', wire.fetch);

    const result = await run(store);

    expect(result).toMatchObject({ evaluated: 1, sent: 1, held: 0, failed: 0 });
    expect(wire.groupPosts()).toHaveLength(1);
  });
});
