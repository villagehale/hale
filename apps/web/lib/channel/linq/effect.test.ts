import type { AgentClient } from '@hale/agent';
import { strictToolSchema } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { runTurn } from '~/lib/channel/router/deadline';
import {
  LINQ_EFFECT_TOOL_SCHEMA,
  type LinqEffectDecider,
  type LinqEffectDecision,
  type LinqEffectInput,
  applyLinqEffect,
  createLinqEffectDecider,
  linqEffectRefusals,
  linqEffectUserMessage,
  linqEffectsEnabled,
} from './effect';
import { considerLinqReply } from './moments';
import { isLinqMessageEffect } from './transport';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'linq-effect', whenToUse: 'x', task: 'screen', tools: [] },
    instructions: 'decide',
  }),
}));
vi.mock('~/lib/channel/outbound-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/channel/outbound-transport')>();
  return { ...actual, sendLinqEffect: vi.fn(actual.sendLinqEffect) };
});

const { forceToolJson } = await import('~/lib/pipeline/structured');
const { sendLinqEffect } = await import('~/lib/channel/outbound-transport');
const CLIENT = {} as AgentClient;
const NOW = new Date('2026-10-28T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const READ: LinqEffectInput = {
  audience: 'direct',
  parentText: 'we got in for swim',
  reply: 'You are in for swim.',
  parentLocalTime: 'Wednesday 8:00 AM America/Toronto',
  lastEffectHoursAgo: null,
};

/** A direct chat: the resolver names nobody. */
const NO_MENTION = async () => undefined;

function decider(decision: LinqEffectDecision | null): LinqEffectDecider & {
  calls: number;
  reads: LinqEffectInput[];
} {
  const fake = {
    calls: 0,
    reads: [] as LinqEffectInput[],
    async decide(input: LinqEffectInput) {
      fake.calls += 1;
      fake.reads.push(input);
      return decision;
    },
  };
  return fake;
}

function linqFetch(status = 201) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    status < 300
      ? Response.json({ message: { id: 'effect-1' } }, { status })
      : Response.json({ error: { code: 400 } }, { status }),
  );
}

function moment(
  fake: ReturnType<typeof makeFakeDb>,
  d: LinqEffectDecider,
  f: typeof fetch,
  extra: {
    now?: Date;
    lastEffectAt?: Date | null;
    timeZone?: string | null;
    templateKey?: string | null;
  } = {},
) {
  return considerLinqReply(fake.db, {
    route: { channel: 'imessage', to: '+14165550101', chatId: CHAT, replyToMessageId: 'in-1' },
    inboundBody: READ.parentText,
    outboundBody: READ.reply,
    templateKey: extra.templateKey ?? null,
    familyId: FAMILY,
    parentUserId: USER,
    now: extra.now ?? NOW,
    fetch: f,
    effect: {
      decider: d,
      audience: 'direct',
      timeZone: extra.timeZone === undefined ? 'America/Toronto' : extra.timeZone,
      lastEffectAt: extra.lastEffectAt ?? null,
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-473 Linq message effects', () => {
  it('lets the model decline with null, which the grammar accepts', () => {
    const grammar = strictToolSchema(LINQ_EFFECT_TOOL_SCHEMA);
    expect(grammar).not.toBeNull();
    const effect = (grammar?.properties as { effect?: { anyOf?: unknown[] } } | undefined)?.effect;
    expect(effect?.anyOf).toEqual(
      expect.arrayContaining([
        { type: 'null' },
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            type: { type: 'string', const: 'screen' },
          }),
        }),
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            type: { type: 'string', const: 'bubble' },
          }),
        }),
      ]),
    );
  });

  it('flag is dark by default and on when exactly true, including Production', () => {
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'on');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'TRUE');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    expect(linqEffectsEnabled()).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(linqEffectsEnabled()).toBe(true);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true\n');
    expect(linqEffectsEnabled()).toBe(true);
  });

  it('hands the model the audience, both bodies, the wall clock and the last effect', () => {
    const payload = JSON.parse(
      linqEffectUserMessage({ ...READ, audience: 'group', lastEffectHoursAgo: 3 }),
    );
    expect(payload).toEqual({
      audience: 'group',
      parent: { text: READ.parentText },
      reply: READ.reply,
      parentLocalTime: 'Wednesday 8:00 AM America/Toronto',
      lastEffectHoursAgo: 3,
    });
  });

  it('accepts every listed screen and bubble name and refuses what Linq cannot carry', () => {
    expect(isLinqMessageEffect({ type: 'screen', name: 'confetti' })).toBe(true);
    expect(isLinqMessageEffect({ type: 'bubble', name: 'gentle' })).toBe(true);
    expect(isLinqMessageEffect({ type: 'screen', name: 'yay' })).toBe(false);
    expect(isLinqMessageEffect({ type: 'bubble', name: 'confetti' })).toBe(false);
    expect(
      linqEffectRefusals({ effect: { type: 'screen', name: 'confetti' } }, READ.reply),
    ).toEqual([]);
    expect(linqEffectRefusals({ effect: null }, READ.reply)).toEqual([]);
    expect(
      linqEffectRefusals({ effect: { type: 'screen', name: 'yay' as 'confetti' } }, READ.reply),
    ).toEqual(['unknown_effect']);
    expect(linqEffectRefusals({ effect: { type: 'screen', name: 'confetti' } }, '   ')).toEqual([
      'empty_text',
    ]);
  });

  it("returns the model's decision, and null when the call throws or comes back unusable", async () => {
    vi.mocked(forceToolJson).mockResolvedValueOnce({
      value: { effect: { type: 'screen', name: 'confetti' } },
    } as never);
    expect(await createLinqEffectDecider(CLIENT).decide(READ)).toEqual({
      effect: { type: 'screen', name: 'confetti' },
    });
    vi.mocked(forceToolJson).mockRejectedValueOnce(new Error('boom'));
    expect(await createLinqEffectDecider(CLIENT).decide(READ)).toBeNull();
    vi.mocked(forceToolJson).mockResolvedValueOnce({
      value: { effect: { type: 'screen', name: 'yay' } },
    } as never);
    expect(await createLinqEffectDecider(CLIENT).decide(READ)).toBeNull();
  });

  it("sends the model's effect with the reply and nothing else", async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    const out = await applyLinqEffect({
      decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
      chatId: CHAT,
      text: READ.reply,
      replyToMessageId: 'in-1',
      read: READ,
      mentionFor: NO_MENTION,
      fetch: f,
    });
    expect(out).toEqual({
      status: 'sent',
      effect: { type: 'screen', name: 'confetti' },
      providerMessageId: 'effect-1',
    });
    expect(String(f.mock.calls[0]?.[0])).toContain(`/chats/${CHAT}/messages`);
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
      message: {
        parts: [{ type: 'text', value: READ.reply }],
        reply_to: { message_id: 'in-1' },
        effect: { type: 'screen', name: 'confetti' },
      },
    });
  });

  it('sends nothing when the model declines or fails, and names a refused send', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const quiet = linqFetch();
    expect(
      await applyLinqEffect({
        decider: decider({ effect: null }),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
        fetch: quiet,
      }),
    ).toEqual({ status: 'declined' });
    expect(
      await applyLinqEffect({
        decider: decider(null),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
        fetch: quiet,
      }),
    ).toEqual({ status: 'not_sent', reason: 'model_failed' });
    expect(quiet).not.toHaveBeenCalled();

    const refused = await applyLinqEffect({
      decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
      chatId: CHAT,
      text: READ.reply,
      replyToMessageId: 'in-1',
      read: READ,
      mentionFor: NO_MENTION,
      fetch: linqFetch(409),
    });
    expect(refused).toMatchObject({ status: 'not_sent', reason: 'refused', httpStatus: 409 });
  });

  it('does not send once the turn deadline has fired', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    const signal = AbortSignal.abort();
    let inner: Promise<unknown> = Promise.resolve();
    const outer = runTurn(signal, () => {
      inner = applyLinqEffect({
        decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
        fetch: f,
      });
      return inner;
    });
    await expect(outer).rejects.toMatchObject({ name: 'DeadlineError', reason: 'turn_timeout' });
    await expect(inner).rejects.toMatchObject({ name: 'DeadlineError', reason: 'turn_timeout' });
    expect(f).not.toHaveBeenCalled();
  });

  it('names a timeout or a missing message id as uncertain, and does not call it a refusal', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    const timeout = vi.fn(async () => {
      throw aborted;
    });
    expect(
      await applyLinqEffect({
        decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
        fetch: timeout,
      }),
    ).toMatchObject({ status: 'uncertain', code: 'timeout' });
    expect(timeout).toHaveBeenCalledTimes(1);

    const missingId = vi.fn(async () => Response.json({}, { status: 201 }));
    expect(
      await applyLinqEffect({
        decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
        fetch: missingId,
      }),
    ).toMatchObject({ status: 'uncertain', code: 'missing_message_id' });
    expect(missingId).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])(
    'names a Linq %i uncertain: the gateway may already have sent it',
    async (httpStatus) => {
      vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
      const upstream = vi.fn(async () =>
        Response.json({ error: { message: 'upstream' } }, { status: httpStatus }),
      );
      expect(
        await applyLinqEffect({
          decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
          chatId: CHAT,
          text: READ.reply,
          replyToMessageId: 'in-1',
          read: READ,
          mentionFor: NO_MENTION,
          fetch: upstream,
        }),
      ).toMatchObject({ status: 'uncertain', httpStatus });
      expect(upstream).toHaveBeenCalledTimes(1);
    },
  );

  it('carries the group mention the plain send would, and reads it only for a chosen effect', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const mentionFor = vi.fn(async () => '+14165550199');
    const f = linqFetch();
    await applyLinqEffect({
      decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
      chatId: CHAT,
      text: READ.reply,
      replyToMessageId: 'in-1',
      read: { ...READ, audience: 'group' },
      mentionFor,
      fetch: f,
    });
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
      message: {
        parts: [{ type: 'text', value: READ.reply, mention: '+14165550199' }],
        reply_to: { message_id: 'in-1' },
        effect: { type: 'screen', name: 'confetti' },
      },
    });

    const declined = vi.fn(async () => '+14165550199');
    await applyLinqEffect({
      decider: decider({ effect: null }),
      chatId: CHAT,
      text: READ.reply,
      replyToMessageId: 'in-1',
      read: { ...READ, audience: 'group' },
      mentionFor: declined,
      fetch: linqFetch(),
    });
    expect(declined).not.toHaveBeenCalled();
  });

  it('holds no clock window and no per-chat quota: the model reads both facts and decides', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    // 23:00 in New York, one hour after the last effect in this chat: the two holds this
    // PR used to have would both have kept the model from being asked.
    const lateNight = new Date('2026-10-29T03:00:00.000Z');
    const fake = makeFakeDb();
    const chosen = decider({ effect: { type: 'bubble', name: 'gentle' } });
    const posted = linqFetch();
    const sent = await moment(fake, chosen, posted, {
      now: lateNight,
      timeZone: 'America/New_York',
      lastEffectAt: new Date(lateNight.getTime() - 90 * 60 * 1000),
    });
    expect(chosen.reads).toEqual([
      {
        audience: 'direct',
        parentText: READ.parentText,
        reply: READ.reply,
        parentLocalTime: 'Wednesday 11:00 PM America/New_York',
        lastEffectHoursAgo: 1,
      },
    ]);
    expect(sent).toEqual({ handled: 'effect', delivery: 'sent', providerMessageId: 'effect-1' });
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it('shows no wall clock for a parent with no stored zone, and none for a chat with no effect', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const chosen = decider({ effect: null });
    await moment(makeFakeDb(), chosen, linqFetch(), { timeZone: null, lastEffectAt: null });
    expect(chosen.reads[0]).toMatchObject({ parentLocalTime: null, lastEffectHoursAgo: null });
  });

  it('is never consulted while the flag is off', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const d = decider({ effect: { type: 'screen', name: 'confetti' } });
    const f = linqFetch();
    expect(await moment(fake, d, f)).toEqual({ handled: false });
    expect(d.calls).toBe(0);
    expect(f).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('sends the reply with the effect the model chose, and leaves its receipts to the router', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const posted = linqFetch();
    const sent = await moment(
      fake,
      decider({ effect: { type: 'screen', name: 'confetti' } }),
      posted,
    );
    expect(sent).toEqual({ handled: 'effect', delivery: 'sent', providerMessageId: 'effect-1' });
    expect(posted).toHaveBeenCalledTimes(1);
    // The effect send is the reply: sendReply writes its row, audit and thread row as
    // for a plain send. Nothing here writes a second set.
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('does not play an effect on a reply that already has its own template key', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const chosen = decider({ effect: { type: 'screen', name: 'confetti' } });
    const posted = linqFetch();
    expect(await moment(fake, chosen, posted, { templateKey: 'flood_line' })).toEqual({
      handled: false,
    });
    expect(chosen.calls).toBe(0);
    expect(posted).not.toHaveBeenCalled();
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('names an unknown send error uncertain, not a refusal', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.mocked(sendLinqEffect).mockRejectedValueOnce(new Error('boom'));
    expect(
      await applyLinqEffect({
        decider: decider({ effect: { type: 'screen', name: 'confetti' } }),
        chatId: CHAT,
        text: READ.reply,
        replyToMessageId: 'in-1',
        read: READ,
        mentionFor: NO_MENTION,
      }),
    ).toEqual({ status: 'uncertain', code: 'unknown' });

    const fake = makeFakeDb();
    const posted = linqFetch();
    vi.mocked(sendLinqEffect).mockRejectedValueOnce(new Error('boom'));
    const sent = await moment(
      fake,
      decider({ effect: { type: 'screen', name: 'confetti' } }),
      posted,
    );
    expect(sent).toEqual({ handled: 'effect', delivery: 'unknown', providerMessageId: null });
    expect(posted).not.toHaveBeenCalled();
  });

  it('treats an uncertain delivery as already sent, so the words are not posted again', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const missing = vi.fn(async () => Response.json({}, { status: 201 }));
    expect(
      await moment(
        makeFakeDb(),
        decider({ effect: { type: 'screen', name: 'confetti' } }),
        missing,
      ),
    ).toEqual({ handled: 'effect', delivery: 'unknown', providerMessageId: null });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('lets the reply go plain when the effect POST never reached Linq', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(
      await moment(fake, decider({ effect: { type: 'screen', name: 'confetti' } }), unreachable),
    ).toEqual({ handled: false });
    expect(unreachable).toHaveBeenCalledTimes(1);
    expect(fake.rows(schema.channelMessages)).toHaveLength(0);
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('lets the reply go out and writes nothing when the model fails or the send is refused', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');

    const failed = makeFakeDb();
    const quiet = linqFetch();
    expect(await moment(failed, decider(null), quiet)).toEqual({ handled: false });
    expect(quiet).not.toHaveBeenCalled();
    expect(failed.rows(schema.auditLog)).toHaveLength(0);

    const refused = makeFakeDb();
    expect(
      await moment(
        refused,
        decider({ effect: { type: 'screen', name: 'confetti' } }),
        linqFetch(409),
      ),
    ).toEqual({ handled: false });
    expect(refused.rows(schema.auditLog)).toHaveLength(0);
  });
});
