import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import type { ReactionPlan } from '~/lib/channel/router/reaction-plan';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { ParentReactionUnsent, considerLinqReply } from './moments';
import type { LinqStickerDecider } from './sticker';
import { linqReactionsEnabled, reactToParentMessage, readParentReaction } from './tapback';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const OTHER_FAMILY = '00000000-0000-4000-8000-0000000000f2';
const USER = '00000000-0000-4000-8000-0000000000a1';
const ROUTE = {
  channel: 'imessage',
  to: '+14165550101',
  chatId: 'chat-1',
  replyToMessageId: 'in-1',
  service: 'iMessage',
} as const satisfies ReplyRoute;
const LOVE = { type: 'love' } as const;

function linqFetch(status = 204) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    status < 300
      ? new Response(null, { status })
      : Response.json({ error: { code: 2029 } }, { status }),
  );
}

const reactionCalls = (f: ReturnType<typeof linqFetch>) =>
  f.mock.calls
    .filter(([url]) => String(url).endsWith('/reactions'))
    .map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body)),
    }));

function stickers(): LinqStickerDecider & { calls: number } {
  const fake = {
    calls: 0,
    async decide() {
      fake.calls += 1;
      return { sticker: '🙌', sendReply: true };
    },
  };
  return fake;
}

function moment(
  fake: ReturnType<typeof makeFakeDb>,
  f: typeof fetch,
  extra: {
    inboundBody?: string;
    outboundBody?: string;
    reaction?: ReactionPlan;
    sticker?: LinqStickerDecider;
  } = {},
) {
  return considerLinqReply(fake.db, {
    route: ROUTE,
    inboundBody: extra.inboundBody ?? 'thanks',
    outboundBody: extra.outboundBody ?? 'Anytime!',
    templateKey: null,
    familyId: FAMILY,
    parentUserId: USER,
    now: NOW,
    fetch: f,
    ...(extra.reaction ? { reaction: extra.reaction } : {}),
    ...(extra.sticker
      ? { sticker: { decider: extra.sticker, audience: 'direct' as const, parentAttachments: [] } }
      : {}),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('linqReactionsEnabled', () => {
  it('unset: on for every family', () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', undefined);
    expect(linqReactionsEnabled(FAMILY)).toBe(true);
    expect(linqReactionsEnabled(OTHER_FAMILY)).toBe(true);
  });

  it('"false" (trimmed): off for every family, and only "false" turns it off', () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'false');
    expect(linqReactionsEnabled(FAMILY)).toBe(false);
    expect(linqReactionsEnabled(OTHER_FAMILY)).toBe(false);
    vi.stubEnv('LINQ_REACTIONS_ENABLED', ' false\n');
    expect(linqReactionsEnabled(FAMILY)).toBe(false);
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true\n');
    expect(linqReactionsEnabled(FAMILY)).toBe(true);
  });
});

describe('readParentReaction', () => {
  it('reads a standard tapback or exactly one emoji, and nothing else', () => {
    expect(readParentReaction('like')).toEqual({ type: 'like' });
    expect(readParentReaction(' 🎉 ')).toEqual({ type: 'custom', emoji: '🎉' });
    expect(readParentReaction('👍🏽')).toEqual({ type: 'custom', emoji: '👍🏽' });
    expect(readParentReaction('🎉🎉')).toBeNull();
    expect(readParentReaction('thumbs up')).toBeNull();
    expect(readParentReaction('Like')).toBeNull();
  });
});

describe('reactToParentMessage', () => {
  it("reacts on the parent's own message and nowhere else", async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    expect(await reactToParentMessage({ route: ROUTE, reaction: LOVE, fetch: f })).toEqual({
      status: 'sent',
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(reactionCalls(f)).toEqual([
      { path: '/api/partner/v3/messages/in-1/reactions', body: { operation: 'add', type: 'love' } },
    ]);
  });

  it('carries a custom emoji as Linq takes it', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    await reactToParentMessage({
      route: ROUTE,
      reaction: { type: 'custom', emoji: '🎉' },
      fetch: f,
    });
    expect(reactionCalls(f)[0]?.body).toEqual({
      operation: 'add',
      type: 'custom',
      custom_emoji: '🎉',
    });
  });

  it('never calls Linq without a parent message to land on', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    expect(
      await reactToParentMessage({
        route: { ...ROUTE, replyToMessageId: null },
        reaction: LOVE,
        fetch: f,
      }),
    ).toEqual({ status: 'not_sent', reason: 'no_parent_message' });
    expect(f).not.toHaveBeenCalled();
  });

  it('names every way it did not land, and never throws', async () => {
    const quiet = linqFetch();
    expect(await reactToParentMessage({ route: ROUTE, reaction: LOVE, fetch: quiet })).toEqual({
      status: 'not_sent',
      reason: 'not_configured',
      code: 'not_configured',
    });
    expect(quiet).not.toHaveBeenCalled();

    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    expect(
      await reactToParentMessage({ route: ROUTE, reaction: LOVE, fetch: linqFetch(409) }),
    ).toMatchObject({ status: 'not_sent', reason: 'refused', httpStatus: 409 });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await reactToParentMessage({ route: ROUTE, reaction: LOVE, fetch: down })).toEqual({
      status: 'not_sent',
      reason: 'unreachable',
      code: 'network',
    });
  });
});

describe('considerLinqReply · the reaction step', () => {
  const ALONE: ReactionPlan = { kind: 'alone', reaction: LOVE, standsFor: 'Anytime!' };
  const BESIDE: ReactionPlan = { kind: 'beside', reaction: LOVE, why: 'not_asked' };

  it("dark: today's word-list tapback, byte for byte, and a plan is never read", async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'false');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const f = linqFetch();
    const out = await moment(fake, f, {
      outboundBody: 'ok',
      reaction: { kind: 'alone', reaction: { type: 'laugh' }, standsFor: 'ok' },
    });
    expect(out).toMatchObject({ handled: true, threadBody: null });
    expect(reactionCalls(f)).toEqual([
      { path: '/api/partner/v3/messages/in-1/reactions', body: { operation: 'add', type: 'like' } },
    ]);
    expect(fake.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:tapback',
      providerMessageId: 'in-1',
    });
  });

  it('lit: the word lists are never consulted - no plan, no reaction', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const f = linqFetch();
    expect(await moment(fake, f, { outboundBody: 'ok' })).toEqual({ handled: false });
    expect(f).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('lit, alone: the reaction is the answer, ledgered and audited, with no words', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const f = linqFetch();
    const out = await moment(fake, f, { reaction: ALONE });
    expect(reactionCalls(f)).toEqual([
      { path: '/api/partner/v3/messages/in-1/reactions', body: { operation: 'add', type: 'love' } },
    ]);
    const [row] = fake.rows(schema.channelMessages);
    expect(out).toEqual({
      handled: true,
      channelMessageId: row?.id,
      threadBody: null,
      reactedAlone: true,
    });
    expect(row).toMatchObject({
      templateKey: 'linq:tapback',
      providerMessageId: 'in-1',
      direction: 'out',
      category: 'reply',
    });
    expect(row?.body ?? null).toBeNull();
    expect(fake.rows(schema.auditLog)).toEqual([
      expect.objectContaining({
        actionTaken: 'linq_tapback',
        targetId: row?.id,
        after: { outcome: 'agent_reacted' },
      }),
    ]);
  });

  it('lit, alone: words a fold added after the plan keep the reply, the reaction goes beside', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const f = linqFetch();
    const out = await moment(fake, f, {
      reaction: ALONE,
      outboundBody: 'Anytime! The pool page: https://pool.example/swim',
    });
    expect(out).toEqual({ handled: false });
    expect(reactionCalls(f)).toHaveLength(1);
    expect(fake.rows(schema.auditLog).map((r) => [r.actionTaken, r.after])).toEqual([
      ['linq_tapback', undefined],
    ]);
  });

  it('lit, beside: one reaction per parent bubble, so no sticker is read', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const f = linqFetch();
    const sticker = stickers();
    expect(await moment(fake, f, { reaction: BESIDE, sticker })).toEqual({ handled: false });
    expect(reactionCalls(f).map((call) => call.body)).toEqual([{ operation: 'add', type: 'love' }]);
    expect(sticker.calls).toBe(0);
    expect(fake.rows(schema.auditLog).map((r) => r.actionTaken)).toEqual(['linq_tapback']);
  });

  it('lit, no reaction chosen: the sticker read still runs (positive control)', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const sticker = stickers();
    await moment(makeFakeDb(), linqFetch(), { sticker });
    expect(sticker.calls).toBe(1);
  });

  it('lit, alone, refused: nothing extra goes - a named refusal, no row', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const refused = moment(fake, linqFetch(409), { reaction: ALONE });
    await expect(refused).rejects.toBeInstanceOf(ParentReactionUnsent);
    await expect(refused).rejects.toMatchObject({ reason: 'refused' });
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('lit, beside, refused: the words still go, and no row claims a reaction', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    expect(await moment(fake, linqFetch(409), { reaction: BESIDE })).toEqual({ handled: false });
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('SMS never reaches the reaction step', async () => {
    vi.stubEnv('LINQ_REACTIONS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    const out = await considerLinqReply(makeFakeDb().db, {
      route: { channel: 'sms', to: '+14165550101' },
      inboundBody: 'thanks',
      outboundBody: 'Anytime!',
      templateKey: null,
      familyId: FAMILY,
      parentUserId: USER,
      now: NOW,
      fetch: f,
      reaction: ALONE,
    });
    expect(out).toEqual({ handled: false });
    expect(f).not.toHaveBeenCalled();
  });
});
