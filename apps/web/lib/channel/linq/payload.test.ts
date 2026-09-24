import { describe, expect, it } from 'vitest';
import { parseLinqWebhook } from './payload';

/** The 2026-02-03 message.received shape from Linq's public event guide.
 * Handles are the documentation examples, not a live line. */
function received(overrides: Record<string, unknown> = {}) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'message.received',
    event_id: '2915e81c-5068-4796-ace2-21d2c94ad298',
    created_at: '2026-02-05T19:31:13.736Z',
    trace_id: 'trace-fixture',
    partner_id: 'partner_fixture',
    data: {
      chat: {
        id: '8f392755-6865-4b18-880a-227f9d8b458f',
        is_group: false,
        owner_handle: { handle: '+12025551234', is_me: true },
      },
      id: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
      direction: 'inbound',
      sender_handle: { handle: '+12025559876', is_me: false, service: 'iMessage' },
      parts: [{ type: 'text', value: 'Hello!' }],
      sent_at: '2026-02-05T19:31:13.074Z',
      service: 'iMessage',
    },
    ...overrides,
  };
}

const FALLBACK = new Date('2026-09-23T12:00:00.000Z');

describe('parseLinqWebhook', () => {
  it('reads the 2026-02-03 sender, chat, and text', () => {
    const parsed = parseLinqWebhook(received(), FALLBACK);
    expect(parsed).toEqual({
      kind: 'message',
      message: {
        messageId: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
        chatId: '8f392755-6865-4b18-880a-227f9d8b458f',
        senderHandle: '+12025559876',
        text: 'Hello!',
        mediaCount: 0,
        receivedAt: new Date('2026-02-05T19:31:13.074Z'),
        otherHandles: [],
      },
    });
  });

  it('counts a media part and keeps the text beside it', () => {
    const body = received();
    const data = body.data as { parts: unknown[] };
    data.parts = [
      { type: 'text', value: 'see this' },
      { type: 'media', id: 'att-1' },
    ];
    const parsed = parseLinqWebhook(body, FALLBACK);
    expect(parsed.kind).toBe('message');
    if (parsed.kind !== 'message') return;
    expect(parsed.message.text).toBe('see this');
    expect(parsed.message.mediaCount).toBe(1);
  });

  it('names a group, an outbound echo, another event, and the old payload version', () => {
    const group = received();
    (group.data as { chat: { is_group: boolean; handles?: unknown[] } }).chat.is_group = true;
    (group.data.chat as unknown as { handles: unknown[] }).handles = [
      { handle: '+12025559876', is_me: false },
      { handle: '+12025550100', is_me: false },
      { handle: '+12025551234', is_me: true },
    ];
    const parsedGroup = parseLinqWebhook(group, FALLBACK);
    expect(parsedGroup.kind).toBe('group');
    if (parsedGroup.kind === 'group') {
      expect(parsedGroup.message.otherHandles).toEqual(['+12025559876', '+12025550100']);
    }

    const outbound = received();
    (outbound.data as { direction: string }).direction = 'outbound';
    expect(parseLinqWebhook(outbound, FALLBACK)).toEqual({ kind: 'ignored', reason: 'outbound' });

    expect(parseLinqWebhook({ ...received(), event_type: 'message.sent' }, FALLBACK)).toEqual({
      kind: 'ignored',
      reason: 'not_message_received',
    });

    expect(parseLinqWebhook({ ...received(), event_type: 'message.delivered' }, FALLBACK)).toEqual({
      kind: 'receipt',
      receipt: {
        event: 'message.delivered',
        messageId: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
        rawStatus: 'delivered',
        errorCode: null,
      },
    });

    const failed = {
      ...received(),
      event_type: 'message.failed',
      data: { message_id: 'fail-1', code: 4001, reason: 'Delivery failed' },
    };
    expect(parseLinqWebhook(failed, FALLBACK)).toEqual({
      kind: 'receipt',
      receipt: {
        event: 'message.failed',
        messageId: 'fail-1',
        rawStatus: 'failed',
        errorCode: '4001',
      },
    });

    expect(parseLinqWebhook({ ...received(), event_type: 'message.read' }, FALLBACK)).toEqual({
      kind: 'receipt',
      receipt: {
        event: 'message.read',
        messageId: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
        rawStatus: 'read',
        errorCode: null,
      },
    });

    expect(parseLinqWebhook({ ...received(), webhook_version: '2025-01-01' }, FALLBACK)).toEqual({
      kind: 'ignored',
      reason: 'unsupported_version',
    });

    expect(
      parseLinqWebhook(
        {
          ...received(),
          event_type: 'reaction.added',
          data: {
            chat_id: '8f392755-6865-4b18-880a-227f9d8b458f',
            message_id: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
            reaction_type: 'like',
            is_from_me: false,
          },
        },
        FALLBACK,
      ),
    ).toEqual({
      kind: 'signal',
      signal: {
        event: 'reaction.added',
        chatId: '8f392755-6865-4b18-880a-227f9d8b458f',
        messageId: '89e3566e-1d13-49e5-a8ee-48490d5bfeb7',
        reactionType: 'like',
        optionId: null,
        senderHandle: null,
        isFromMe: false,
      },
    });

    expect(
      parseLinqWebhook(
        {
          ...received(),
          event_type: 'chat.typing_indicator.started',
          data: {
            chat_id: '8f392755-6865-4b18-880a-227f9d8b458f',
          },
        },
        FALLBACK,
      ).kind,
    ).toBe('signal');

    const vote = parseLinqWebhook(
      {
        ...received(),
        event_type: 'poll.vote.added',
        data: {
          chat: { id: '8f392755-6865-4b18-880a-227f9d8b458f' },
          message_id: 'poll-msg',
          option_id: 'opt-1',
          sender_handle: { handle: '+12025559876', is_me: false },
        },
      },
      FALLBACK,
    );
    expect(vote).toMatchObject({
      kind: 'signal',
      signal: { event: 'poll.vote.added', optionId: 'opt-1', senderHandle: '+12025559876' },
    });
  });
});
