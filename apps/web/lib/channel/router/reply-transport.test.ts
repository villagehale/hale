import { describe, expect, it, vi } from 'vitest';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { createReplyTransport } from './reply-transport';

describe('router reply transport — iMessage', () => {
  it('sends into the Linq chat and does not touch the phone transport', async () => {
    const phone: ChannelTransport = { send: vi.fn() };
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-1' }));
    const transport = createReplyTransport({ phone, email: null, imessage });

    const sent = await transport.send({
      route: { channel: 'imessage', to: '+12025559876', chatId: 'chat-1' },
      body: 'swimming moved to Thursday',
    });

    expect(sent).toEqual({ providerMessageId: 'msg-out-1', channel: 'imessage' });
    expect(imessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      body: 'swimming moved to Thursday',
    });
    expect(phone.send).not.toHaveBeenCalled();
  });
});
