import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  GROUP_OFFER_TALLY_SEAM,
  GROUP_OFFER_TEMPLATE,
  type GroupPollOfferDecision,
  type GroupPollOfferJudge,
  considerStuckGroupPoll,
  pollOfferFromAnswer,
  pollOfferUserMessage,
} from './group-poll-offer';

// What the model offers is the eval's job (run-group-poll-offer-eval.mjs). The
// judge here is a fixed decision; these tests cover only what code owns: flags,
// quiet hours, one ask, open/recent offers, that a failed read sends nothing,
// and that a yes is one text (no native poll card).

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

function textWire(): {
  fetch: typeof fetch;
  texts: () => string[];
  pollPosts: () => number;
} {
  const texts: string[] = [];
  let pollPosts = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/polls')) {
      pollPosts += 1;
      return new Response(JSON.stringify({ message_id: 'poll-unexpected' }), { status: 202 });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const message = body?.message as { parts?: { type?: string; value?: string }[] } | undefined;
    for (const part of message?.parts ?? []) {
      if (part.type === 'text' && part.value) texts.push(part.value);
    }
    return new Response(JSON.stringify({ message: { id: `m-${texts.length}` } }), { status: 201 });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    texts: () => texts,
    pollPosts: () => pollPosts,
  };
}

const yes: GroupPollOfferDecision = {
  offer: true,
  text: 'Saturday or Sunday — tap a reaction or reply with the day that works.',
  options: ['Saturday', 'Sunday'],
};

describe('group poll offer (VIL-458 slice 2)', () => {
  it('names the shared #938 tally as the vote reader, not a second counter here', () => {
    expect(GROUP_OFFER_TALLY_SEAM.reader).toBe('pr-938-group-plan-rsvp');
    expect(GROUP_OFFER_TALLY_SEAM.path).toBe('apps/web/lib/channel/linq/group-plan-rsvp');
  });

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

  it('rejects an offer with fewer than two options or an empty text', () => {
    expect(pollOfferFromAnswer({ offer: true, text: 'hi', options: ['Saturday'] })).toBeNull();
    expect(
      pollOfferFromAnswer({ offer: true, text: '', options: ['Saturday', 'Sunday'] }),
    ).toBeNull();
    expect(pollOfferFromAnswer({ offer: false, text: '', options: [] })).toEqual({
      offer: false,
      text: '',
      options: [],
    });
  });

  it('does not call the judge or send when the group flags are off', async () => {
    vi.stubEnv('LINQ_POLLS', '');
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = textWire();
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
    expect(wire.pollPosts()).toBe(0);
  });

  it('does not call the judge or send during quiet hours', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = textWire();
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
    expect(wire.pollPosts()).toBe(0);
  });

  it('does not offer a second ask in the same turn', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = textWire();
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
    expect(wire.pollPosts()).toBe(0);
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
    const wire = textWire();
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

  it('does not offer when Hale sent a text offer in this chat recently', async () => {
    const seeded = await seedFamily();
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.userId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: GROUP_OFFER_TEMPLATE,
      providerChatId: CHAT,
      providerMessageId: 'offer-recent',
      status: acceptedStatus('imessage'),
      sentAt: new Date(DAY.getTime() - 60 * 60 * 1000),
    });
    const judge = fixed(yes);
    const wire = textWire();
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

  it('does not offer when Hale recently sent a native poll in this chat', async () => {
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
    const wire = textWire();
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
    const no = fixed({ offer: false, text: '', options: [] });
    const unread = fixed(null);
    const wire = textWire();
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
    expect(wire.pollPosts()).toBe(0);
  });

  it('sends the model-written text only — no native poll card', async () => {
    const seeded = await seedFamily();
    const judge = fixed(yes);
    const wire = textWire();
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
    expect(wire.texts()).toEqual([yes.text]);
    expect(wire.pollPosts()).toBe(0);
    const ledger = await db.database
      .select({ templateKey: schema.channelMessages.templateKey })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, seeded.familyId));
    expect(ledger).toEqual([{ templateKey: GROUP_OFFER_TEMPLATE }]);
    const pollRows = await db.database
      .select({ id: schema.linqPollOptions.id })
      .from(schema.linqPollOptions)
      .where(eq(schema.linqPollOptions.familyId, seeded.familyId));
    expect(pollRows).toEqual([]);
  });
});
