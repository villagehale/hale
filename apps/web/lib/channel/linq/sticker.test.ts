import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { considerLinqReply } from './moments';
import { parseLinqWebhook } from './payload';
import {
  type LinqStickerDecider,
  type LinqStickerDecision,
  applyLinqSticker,
  createLinqStickerDecider,
  linqStickerRefusals,
  linqStickerUserMessage,
  linqStickersEnabled,
} from './sticker';

vi.mock('~/lib/pipeline/structured', () => ({ forceToolJson: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({
  loadCronSkill: async () => ({
    meta: { name: 'linq-sticker', whenToUse: 'x', task: 'screen', tools: [] },
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
  parentText: 'perfect, see you saturday',
  parentAttachments: [],
  reply: 'Great.',
};

function decider(decision: LinqStickerDecision | null): LinqStickerDecider & {
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

function linqFetch(status = 202) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    status < 300
      ? Response.json({}, { status })
      : Response.json({ error: { code: 2029 } }, { status }),
  );
}

function moment(fake: ReturnType<typeof makeFakeDb>, d: LinqStickerDecider, f: typeof fetch) {
  return considerLinqReply(fake.db, {
    route: { channel: 'imessage', to: '+14165550101', chatId: CHAT, replyToMessageId: 'in-1' },
    inboundBody: 'perfect, see you saturday',
    outboundBody: 'Great, Saturday at 10 at the rec centre.',
    templateKey: null,
    familyId: FAMILY,
    parentUserId: USER,
    now: NOW,
    fetch: f,
    sticker: { decider: d, audience: 'direct', parentAttachments: [] },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(forceToolJson).mockReset();
});

describe('VIL-472 Linq stickers', () => {
  it('is off unless the flag is exactly true', () => {
    expect(linqStickersEnabled()).toBe(false);
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'on');
    expect(linqStickersEnabled()).toBe(false);
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    expect(linqStickersEnabled()).toBe(true);
  });

  it('hands the model the audience, the parent message, its attachment kinds and the reply', () => {
    const payload = JSON.parse(
      linqStickerUserMessage({ ...READ, audience: 'group', parentAttachments: ['image'] }),
    );
    expect(payload).toEqual({
      audience: 'group',
      parent: { text: READ.parentText, attachments: ['image'] },
      reply: READ.reply,
    });
  });

  it('accepts one emoji of any shape and refuses what a peel cannot carry', () => {
    for (const sticker of ['🎉', '👍🏽', '❤️', '🇨🇦', '👨‍👩‍👧']) {
      expect(linqStickerRefusals({ sticker, sendReply: false })).toEqual([]);
    }
    expect(linqStickerRefusals({ sticker: null, sendReply: true })).toEqual([]);
    expect(linqStickerRefusals({ sticker: '🎉🎉', sendReply: true })).toEqual(['not_one_emoji']);
    expect(linqStickerRefusals({ sticker: 'nice', sendReply: true })).toEqual(['not_one_emoji']);
    expect(linqStickerRefusals({ sticker: null, sendReply: false })).toEqual(['silent_turn']);
  });

  it("returns the model's decision, and null when the call throws or comes back unusable", async () => {
    vi.mocked(forceToolJson).mockResolvedValueOnce({
      value: { sticker: '🙌', sendReply: false },
    } as never);
    expect(await createLinqStickerDecider(CLIENT).decide(READ)).toEqual({
      sticker: '🙌',
      sendReply: false,
    });
    vi.mocked(forceToolJson).mockRejectedValueOnce(new Error('boom'));
    expect(await createLinqStickerDecider(CLIENT).decide(READ)).toBeNull();
    vi.mocked(forceToolJson).mockResolvedValueOnce({
      value: { sticker: 'see you then!', sendReply: false },
    } as never);
    expect(await createLinqStickerDecider(CLIENT).decide(READ)).toBeNull();
  });

  it("peels the model's emoji onto the parent's message and nothing else", async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const f = linqFetch();
    const out = await applyLinqSticker({
      decider: decider({ sticker: '🙌', sendReply: true }),
      inboundMessageId: 'in-1',
      read: READ,
      fetch: f,
    });
    expect(out).toEqual({ status: 'peeled', sticker: '🙌', sendReply: true });
    expect(String(f.mock.calls[0]?.[0])).toContain('/messages/in-1/reactions');
    expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'add',
      type: 'sticker',
      emoji: '🙌',
    });
  });

  it('sends nothing when the model declines or fails, and names a refused peel', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const quiet = linqFetch();
    expect(
      await applyLinqSticker({
        decider: decider({ sticker: null, sendReply: true }),
        inboundMessageId: 'in-1',
        read: READ,
        fetch: quiet,
      }),
    ).toEqual({ status: 'declined' });
    expect(
      await applyLinqSticker({
        decider: decider(null),
        inboundMessageId: 'in-1',
        read: READ,
        fetch: quiet,
      }),
    ).toEqual({ status: 'not_peeled', reason: 'model_failed' });
    expect(quiet).not.toHaveBeenCalled();

    const refused = await applyLinqSticker({
      decider: decider({ sticker: '🙌', sendReply: false }),
      inboundMessageId: 'in-1',
      read: READ,
      fetch: linqFetch(409),
    });
    expect(refused).toMatchObject({ status: 'not_peeled', reason: 'refused', httpStatus: 409 });
  });

  it('is never consulted while the flag is off', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fake = makeFakeDb();
    const d = decider({ sticker: '🙌', sendReply: false });
    const f = linqFetch();
    expect(await moment(fake, d, f)).toEqual({ handled: false });
    expect(d.calls).toBe(0);
    expect(f).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditLog)).toHaveLength(0);
  });

  it('stands in for the reply only when the model says so, and audits the peel', async () => {
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');

    const alone = makeFakeDb();
    const instead = await moment(alone, decider({ sticker: '🙌', sendReply: false }), linqFetch());
    expect(instead.handled).toBe(true);
    expect(alone.rows(schema.auditLog).map((r) => r.actionTaken)).toEqual(['linq_sticker']);
    expect(alone.rows(schema.channelMessages)[0]).toMatchObject({
      templateKey: 'linq:sticker',
      providerMessageId: 'in-1',
      direction: 'out',
    });

    const beside = makeFakeDb();
    const both = await moment(beside, decider({ sticker: '🙌', sendReply: true }), linqFetch());
    expect(both).toEqual({ handled: false });
    expect(beside.rows(schema.auditLog).map((r) => r.actionTaken)).toEqual(['linq_sticker']);
  });

  it('lets the reply go out and writes nothing when the model fails or the peel is refused', async () => {
    vi.stubEnv('LINQ_STICKERS_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');

    const failed = makeFakeDb();
    const quiet = linqFetch();
    expect(await moment(failed, decider(null), quiet)).toEqual({ handled: false });
    expect(quiet).not.toHaveBeenCalled();
    expect(failed.rows(schema.auditLog)).toHaveLength(0);

    const refused = makeFakeDb();
    expect(
      await moment(refused, decider({ sticker: '🙌', sendReply: false }), linqFetch(409)),
    ).toEqual({ handled: false });
    expect(refused.rows(schema.auditLog)).toHaveLength(0);
  });
});

describe('VIL-472 reading stickers a parent sends', () => {
  const base = {
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    data: {
      id: 'in-9',
      direction: 'inbound',
      chat: { id: CHAT, is_group: false },
      sender_handle: { handle: '+14165550101', is_me: false },
      sent_at: NOW.toISOString(),
    },
  };

  it('reads a sticker sent as its own message as an image the coach sees', () => {
    const parsed = parseLinqWebhook(
      {
        ...base,
        data: {
          ...base.data,
          parts: [
            {
              type: 'media',
              url: 'https://cdn.linqapp.com/attachments/x/sticker.png',
              mime_type: 'image/png',
            },
          ],
        },
      },
      NOW,
    );
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.message.media).toEqual([
      {
        kind: 'image',
        url: 'https://cdn.linqapp.com/attachments/x/sticker.png',
        mime: 'image/png',
      },
    ]);
  });

  it('reads a sticker peeled onto a message as a reaction, not a text to answer', () => {
    const parsed = parseLinqWebhook(
      {
        webhook_version: '2026-02-03',
        event_type: 'reaction.added',
        data: {
          chat_id: CHAT,
          message_id: 'out-1',
          reaction_type: 'sticker',
          is_from_me: false,
          from_handle: { handle: '+14165550101', is_me: false },
          sticker: {
            file_name: 'sticker.png',
            mime_type: 'image/png',
            url: 'https://cdn.linqapp.com/attachments/x/sticker.png',
          },
        },
      },
      NOW,
    );
    expect(parsed).toMatchObject({
      kind: 'signal',
      signal: { event: 'reaction.added', reactionType: 'sticker', messageId: 'out-1' },
    });
  });
});
