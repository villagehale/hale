import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import {
  type LinqEffectDecider,
  type LinqEffectDecision,
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

const { forceToolJson } = await import('~/lib/pipeline/structured');
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

function moment(fake: ReturnType<typeof makeFakeDb>, d: LinqEffectDecider, f: typeof fetch) {
  return considerLinqReply(fake.db, {
    route: { channel: 'imessage', to: '+14165550101', chatId: CHAT, replyToMessageId: 'in-1' },
    inboundBody: READ.parentText,
    outboundBody: READ.reply,
    templateKey: null,
    familyId: FAMILY,
    parentUserId: USER,
    now: NOW,
    fetch: f,
    effect: { decider: d, audience: 'direct' },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-473 Linq message effects', () => {
  it('is off unless the flag is exactly true', () => {
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'on');
    expect(linqEffectsEnabled()).toBe(false);
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
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

  it('lets the reply go out and writes nothing when the model fails or the send is refused', async () => {
    vi.stubEnv('LINQ_EFFECTS_ENABLED', 'true');
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
