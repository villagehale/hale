import type { AgentClient } from '@hale/agent';
import { strictToolSchema } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { runTurn } from '~/lib/channel/router/deadline';
import {
  LINQ_EFFECT_REPEAT_MS,
  LINQ_EFFECT_TOOL_SCHEMA,
  type LinqEffectDecider,
  type LinqEffectDecision,
  applyLinqEffect,
  createLinqEffectDecider,
  linqEffectHold,
  linqEffectRefusals,
  linqEffectUserMessage,
  linqEffectsEnabled,
} from './effect';
import { LinqMomentDeliveredError, considerLinqReply } from './moments';
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
const READ = {
  audience: 'direct' as const,
  parentText: 'we got in for swim',
  reply: 'You are in for swim.',
};

function decider(decision: LinqEffectDecision | null): LinqEffectDecider & {
  calls: number;
} {
  const fake = {
    calls: 0,
    async decide() {
      fake.calls += 1;
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
    timeZone?: string;
    templateKey?: string | null;
    medicalReplySource?: 'fixed' | 'web_grounded' | null;
    replySource?: 'composed' | 'fixed' | null;
    relatedConversationId?: string | null;
  } = {},
) {
  return considerLinqReply(fake.db, {
    route: { channel: 'imessage', to: '+14165550101', chatId: CHAT, replyToMessageId: 'in-1' },
    inboundBody: READ.parentText,
    outboundBody: READ.reply,
    templateKey: extra.templateKey ?? null,
    medicalReplySource: extra.medicalReplySource ?? null,
    replySource: extra.replySource ?? null,
    relatedConversationId: extra.relatedConversationId ?? null,
    familyId: FAMILY,
    parentUserId: USER,
    now: extra.now ?? NOW,
    fetch: f,
    effect: {
      decider: d,
      audience: 'direct',
      timeZone: extra.timeZone ?? 'America/Toronto',
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

  it('is on only in Preview when the flag is exactly true', () => {
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('VERCEL_ENV', 'development');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'on');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(linqEffectsEnabled()).toBe(true);
  });

  it('hands the model the audience, the parent message and the reply', () => {
    const payload = JSON.parse(
      linqEffectUserMessage({ ...READ, audience: 'group', parentText: READ.parentText }),
    );
    expect(payload).toEqual({
      audience: 'group',
      parent: { text: READ.parentText },
      reply: READ.reply,
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
        fetch: missingId,
      }),
    ).toMatchObject({ status: 'uncertain', code: 'missing_message_id' });
    expect(missingId).toHaveBeenCalledTimes(1);
  });

  it('does not play an effect during quiet hours or again in the same chat within 24h', async () => {
    const torontoAfternoon = new Date('2026-10-28T16:00:00.000Z');
    const torontoNight = new Date('2026-10-29T03:00:00.000Z');
    expect(
      linqEffectHold({
        now: torontoAfternoon,
        timeZone: 'America/Toronto',
        lastEffectAt: null,
      }),
    ).toBeNull();
    expect(
      linqEffectHold({
        now: torontoNight,
        timeZone: 'America/Toronto',
        lastEffectAt: null,
      }),
    ).toBe('quiet_hours');
    expect(
      linqEffectHold({
        now: torontoAfternoon,
        timeZone: 'America/Toronto',
        lastEffectAt: new Date(torontoAfternoon.getTime() - 60 * 60 * 1000),
      }),
    ).toBe('recent_in_chat');
    expect(
      linqEffectHold({
        now: torontoAfternoon,
        timeZone: 'America/Toronto',
        lastEffectAt: new Date(torontoAfternoon.getTime() - LINQ_EFFECT_REPEAT_MS),
      }),
    ).toBeNull();

    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const quiet = makeFakeDb();
    const quietDecider = decider({ effect: { type: 'screen', name: 'confetti' } });
    const quietFetch = linqFetch();
    expect(await moment(quiet, quietDecider, quietFetch, { now: torontoNight })).toEqual({
      handled: false,
    });
    expect(quietDecider.calls).toBe(0);
    expect(quietFetch).not.toHaveBeenCalled();

    const recent = makeFakeDb();
    const recentDecider = decider({ effect: { type: 'screen', name: 'confetti' } });
    const recentFetch = linqFetch();
    expect(
      await moment(recent, recentDecider, recentFetch, {
        now: torontoAfternoon,
        lastEffectAt: new Date(torontoAfternoon.getTime() - 60 * 60 * 1000),
      }),
    ).toEqual({ handled: false });
    expect(recentDecider.calls).toBe(0);
    expect(recentFetch).not.toHaveBeenCalled();
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

  it('sends the reply with the effect the model chose, and audits it', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const sent = await moment(
      fake,
      decider({ effect: { type: 'screen', name: 'confetti' } }),
      linqFetch(),
    );
    expect(sent).toEqual({
      handled: true,
      channelMessageId: expect.any(String),
      threadBody: READ.reply,
    });
    expect(fake.rows(schema.auditLog).map((r) => r.actionTaken)).toEqual(['linq_effect']);
    expect(fake.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:effect',
      providerMessageId: 'effect-1',
      direction: 'out',
    });
  });

  it('keeps the reply sources on an unkeyed effect row', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const conversationId = '00000000-0000-4000-8000-0000000000c1';
    const fake = makeFakeDb();
    await moment(fake, decider({ effect: { type: 'screen', name: 'confetti' } }), linqFetch(), {
      medicalReplySource: 'fixed',
      replySource: 'composed',
      relatedConversationId: conversationId,
    });
    expect(fake.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:effect',
      medicalReplySource: 'fixed',
      replySource: 'composed',
      relatedConversationId: conversationId,
      providerMessageId: 'effect-1',
    });
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

  it('ledgers an unknown send error and does not treat it as a refusal', async () => {
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
    expect(sent).toMatchObject({ handled: true, threadBody: READ.reply });
    expect(posted).not.toHaveBeenCalled();
    expect(fake.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:effect',
      providerMessageId: null,
    });
  });

  it('treats an uncertain delivery as already sent, and a ledger failure as not a second chance', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const uncertain = makeFakeDb();
    const missing = vi.fn(async () => Response.json({}, { status: 201 }));
    expect(
      await moment(uncertain, decider({ effect: { type: 'screen', name: 'confetti' } }), missing),
    ).toMatchObject({ handled: true, threadBody: READ.reply });
    expect(missing).toHaveBeenCalledTimes(1);
    expect(uncertain.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:effect',
      providerMessageId: null,
    });

    const broken = makeFakeDb();
    const insert = broken.db.insert.bind(broken.db);
    broken.db.insert = ((table: Parameters<typeof insert>[0]) => {
      if (table === schema.channelMessages) throw new Error('bad row');
      return insert(table);
    }) as typeof broken.db.insert;
    const posted = linqFetch();
    await expect(
      moment(broken, decider({ effect: { type: 'screen', name: 'confetti' } }), posted),
    ).rejects.toBeInstanceOf(LinqMomentDeliveredError);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(broken.rows(schema.channelMessages)).toHaveLength(0);
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
