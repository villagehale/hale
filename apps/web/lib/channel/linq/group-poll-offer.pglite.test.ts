import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type GroupPollOfferDecision,
  type GroupPollOfferJudge,
  considerStuckGroupPoll,
  pollOfferFromAnswer,
  pollOfferUserMessage,
} from './group-poll-offer';

// What the model offers is the eval's job (run-group-poll-offer-eval.mjs). The
// judge here is a fixed decision; these tests cover only what code owns: flags,
// quiet hours, one ask, open/recent polls, and that a failed read sends nothing.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('LINQ_POLLS', 'on');
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users, channel_messages, linq_poll_options cascade');
});

const DAY = new Date('2026-09-25T18:00:00.000Z');
const QUIET = new Date('2026-09-25T03:00:00.000Z');
const CHAT = 'chat-group-stuck';
const STUCK = [
  { from: 'Ana', text: 'Saturday or Sunday for the park?' },
  { from: 'Barton', text: 'Sat is swim. Sunday?' },
  { from: 'Julie', text: 'Saturday is better for us' },
];

async function seedFamily(): Promise<{ familyId: string; userId: string }> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: 'Ana', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Lee', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const userId = user?.id as string;
  const familyId = family?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
  return { familyId, userId };
}

const fixed = (d: GroupPollOfferDecision | null): GroupPollOfferJudge & { calls: number } => {
  const judge = {
    calls: 0,
    async decide() {
      judge.calls += 1;
      return d;
    },
  };
  return judge;
};

function pollWire(): {
  fetch: typeof fetch;
  texts: () => string[];
  pollOptions: () => string[];
} {
  const texts: string[] = [];
  const pollOptions: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
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
              option_id: `opt-${index}`,
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
  };
}

const yes: GroupPollOfferDecision = {
  offer: true,
  prompt: 'Which day for the park?',
  options: ['Saturday', 'Sunday'],
};

describe('group poll offer (VIL-458 slice 2)', () => {
  it('sends the model the thread and the two facts, never ids', () => {
    const msg = pollOfferUserMessage({
      openPoll: true,
      recentOffer: false,
      messages: STUCK,
    });
    expect(msg).not.toContain(CHAT);
    expect(msg).not.toContain('opt-');
    const parsed = JSON.parse(msg);
    expect(parsed.openPoll).toBe(true);
    expect(parsed.recentOffer).toBe(false);
    expect(parsed.messages[0]).toEqual({ from: 'Ana', text: STUCK[0]?.text });
  });

  it('rejects an offer with fewer than two options', () => {
    expect(pollOfferFromAnswer({ offer: true, prompt: 'hi', options: ['Saturday'] })).toBeNull();
    expect(pollOfferFromAnswer({ offer: false, prompt: '', options: [] })).toEqual({
      offer: false,
      prompt: '',
      options: [],
    });
  });

  it('does not call the judge or send when the group flags are off', async () => {
    vi.stubEnv('LINQ_POLLS', '');
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(judge.calls).toBe(0);
    expect(wire.texts()).toEqual([]);
    expect(wire.pollOptions()).toEqual([]);
  });

  it('does not call the judge or send during quiet hours', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: QUIET,
      fetch: wire.fetch,
    });
    expect(out).toEqual({ status: 'held', reason: 'quiet_hours' });
    expect(judge.calls).toBe(0);
    expect(wire.pollOptions()).toEqual([]);
  });

  it('does not offer a second ask in the same turn', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      alreadyAskedThisTurn: true,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'already_asked' });
    expect(judge.calls).toBe(0);
    expect(wire.pollOptions()).toEqual([]);
  });

  it('does not offer when a poll is already open in this chat', async () => {
    const seeded = await seedFamily();
    await db.database.insert(schema.linqPollOptions).values({
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      providerChatId: CHAT,
      providerMessageId: 'poll-open',
      optionId: 'opt-a',
      optionText: 'Saturday',
      createdAt: DAY,
    });
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'poll_open' });
    expect(judge.calls).toBe(0);
  });

  it('does not offer when Hale offered a poll in this chat recently', async () => {
    const seeded = await seedFamily();
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:poll',
      providerChatId: CHAT,
      providerMessageId: 'poll-recent',
      status: acceptedStatus('imessage'),
      sentAt: new Date(DAY.getTime() - 60 * 60 * 1000),
    });
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'recent_offer' });
    expect(judge.calls).toBe(0);
  });

  it('sends nothing when the judge says no, or when the read fails', async () => {
    const seeded = await seedFamily();
    const no = fixed({ offer: false, prompt: '', options: [] });
    const unread = fixed(null);
    const wire = pollWire();
    const declined = await considerStuckGroupPoll(db.database, no, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    const failed = await considerStuckGroupPoll(db.database, unread, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(declined).toEqual({ status: 'skipped', reason: 'judge_no' });
    expect(failed).toEqual({ status: 'skipped', reason: 'model_unreachable' });
    expect(no.calls).toBe(1);
    expect(unread.calls).toBe(1);
    expect(wire.texts()).toEqual([]);
    expect(wire.pollOptions()).toEqual([]);
  });

  it('sends the model-written prompt and options through sendChoicePoll', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = pollWire();
    const out = await considerStuckGroupPoll(db.database, judge, {
      chatId: CHAT,
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      messages: STUCK,
      now: DAY,
      fetch: wire.fetch,
    });
    expect(out.status).toBe('sent');
    expect(judge.calls).toBe(1);
    expect(wire.texts()).toEqual(['Which day for the park?']);
    expect(wire.pollOptions()).toEqual(['Saturday', 'Sunday']);
  });
});
