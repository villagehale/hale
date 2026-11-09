import { describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { createReplyTransport } from './reply-transport';

describe('router reply transport — iMessage', () => {
  it('sends into the Linq chat and does not touch the phone transport', async () => {
    const phone: ChannelTransport = { send: vi.fn() };
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-1' }));
    const transport = createReplyTransport({ phone, imessage });

    const sent = await transport.send({
      route: {
        channel: 'imessage',
        to: '+12025559876',
        chatId: 'chat-1',
        replyToMessageId: 'msg-in-1',
      },
      body: 'swimming moved to Thursday',
    });

    expect(sent).toEqual({ providerMessageId: 'msg-out-1', channel: 'imessage' });
    expect(imessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      body: 'swimming moved to Thursday',
      replyToMessageId: 'msg-in-1',
    });
    expect(phone.send).not.toHaveBeenCalled();
  });

  it('answers a parent-started 1:1 in that chat, not the household group', async () => {
    const phone: ChannelTransport = { send: vi.fn() };
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-2' }));
    const transport = createReplyTransport({ phone, imessage });
    const groupChatId = 'chat-household-group';

    await transport.send({
      route: {
        channel: 'imessage',
        to: '+12025559876',
        chatId: 'chat-one-to-one',
        replyToMessageId: 'msg-in-2',
      },
      body: 'You are in for swim.',
    });

    expect(imessage).toHaveBeenCalledWith({
      chatId: 'chat-one-to-one',
      body: 'You are in for swim.',
      replyToMessageId: 'msg-in-2',
    });
    expect(JSON.stringify(imessage.mock.calls)).not.toContain(groupChatId);
    expect(phone.send).not.toHaveBeenCalled();
  });

  it('asks who to mention, then sends that handle into the chat', async () => {
    const phone: ChannelTransport = { send: vi.fn() };
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-3' }));
    const mentionFor = vi.fn(async () => '+14155551234');
    const transport = createReplyTransport({ phone, imessage, mentionFor });

    await transport.send({
      route: {
        channel: 'imessage',
        to: '+12025559876',
        chatId: 'chat-group',
        replyToMessageId: 'msg-in-3',
      },
      body: 'Swim is at 4.',
    });

    expect(mentionFor).toHaveBeenCalledWith({ chatId: 'chat-group', body: 'Swim is at 4.' });
    expect(imessage).toHaveBeenCalledWith({
      chatId: 'chat-group',
      body: 'Swim is at 4.',
      replyToMessageId: 'msg-in-3',
      mention: '+14155551234',
    });
  });
});
