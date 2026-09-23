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
    (group.data as { chat: { is_group: boolean } }).chat.is_group = true;
    expect(parseLinqWebhook(group, FALLBACK)).toEqual({ kind: 'ignored', reason: 'group' });

    const outbound = received();
    (outbound.data as { direction: string }).direction = 'outbound';
    expect(parseLinqWebhook(outbound, FALLBACK)).toEqual({ kind: 'ignored', reason: 'outbound' });

    expect(parseLinqWebhook({ ...received(), event_type: 'message.sent' }, FALLBACK)).toEqual({
      kind: 'ignored',
      reason: 'not_message_received',
    });

    expect(parseLinqWebhook({ ...received(), webhook_version: '2025-01-01' }, FALLBACK)).toEqual({
      kind: 'ignored',
      reason: 'unsupported_version',
    });
  });
});
