import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinqSendError,
  addLinqParticipant,
  createLinqChat,
  createLinqTextTransport,
  markLinqChatRead,
  reactToLinqMessage,
  removeLinqParticipant,
  sendLinqChatMessage,
  sendLinqEffect,
  sendLinqParts,
  sendLinqPoll,
  setupLinqContactCard,
  shareLinqContactCard,
  startLinqTyping,
  stopLinqTyping,
  updateLinqGroupChat,
} from './transport';

const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const API_KEY = 'linq_test_key_not_a_secret';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('sendLinqChatMessage', () => {
  it('names a missing API key and does not call the network', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendLinqChatMessage({ chatId: CHAT, text: 'hi' })).rejects.toMatchObject({
      code: 'not_configured',
      permanent: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a text part into the existing chat and reads message.id', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ chat_id: CHAT, message: { id: 'msg-out-1' } }, { status: 201 }),
    );

    const sent = await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Thursday works',
      fetch: fetchMock,
    });

    expect(sent).toEqual({ providerMessageId: 'msg-out-1' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error('expected a fetch init');
    expect(url).toBe(`https://api.linqapp.com/api/partner/v3/chats/${CHAT}/messages`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      message: { parts: [{ type: 'text', value: 'Thursday works' }] },
    });
  });

  it('classifies a 4xx as permanent and a 5xx as retryable, without echoing the body', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const refused = vi.fn(async () =>
      Response.json(
        { error: { status: 404, code: 2001, message: 'chat gone: Thursday works' } },
        { status: 404 },
      ),
    );
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Thursday works', fetch: refused }),
    ).rejects.toMatchObject({ code: '2001', httpStatus: 404, permanent: true });

    const down = vi.fn(async () => Response.json({ error: { code: 3006 } }, { status: 500 }));
    const error = await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Thursday works',
      fetch: down,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LinqSendError);
    expect(error).toMatchObject({ code: '3006', permanent: false });
    expect((error as Error).message).not.toContain('Thursday');
  });

  it('threads the bubble under the inbound message', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = jsonFetch(201, { message: { id: 'msg-out-2' } });

    const sent = await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Thursday works',
      replyTo: { messageId: 'msg-in-1' },
      fetch: fetchMock,
    });

    expect(sent).toEqual({ providerMessageId: 'msg-out-2' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      message: {
        parts: [{ type: 'text', value: 'Thursday works' }],
        reply_to: { message_id: 'msg-in-1' },
      },
    });
  });

  it('sends the answer plain when Linq refuses the thread target', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return Response.json(
          { error: { status: 400, code: 4001, message: 'reply_to: Thursday works' } },
          { status: 400 },
        );
      }
      return Response.json({ message: { id: 'msg-plain' } }, { status: 201 });
    });

    const sent = await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Thursday works',
      replyTo: { messageId: 'msg-in-1' },
      fetch: fetchMock,
    });

    expect(sent).toEqual({ providerMessageId: 'msg-plain' });
    expect(bodies).toEqual([
      {
        message: {
          parts: [{ type: 'text', value: 'Thursday works' }],
          reply_to: { message_id: 'msg-in-1' },
        },
      },
      { message: { parts: [{ type: 'text', value: 'Thursday works' }] } },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('Thursday');
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(CHAT);
    warn.mockRestore();
  });

  it('does not drop a retryable refusal just because a thread target was set', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const down = vi.fn(async () => Response.json({ error: { code: 3006 } }, { status: 500 }));
    await expect(
      sendLinqChatMessage({
        chatId: CHAT,
        text: 'Thursday works',
        replyTo: { messageId: 'msg-in-1' },
        fetch: down,
      }),
    ).rejects.toMatchObject({ code: '3006', permanent: false });
    expect(down).toHaveBeenCalledOnce();
  });
});

describe('createLinqTextTransport', () => {
  it('threads the within-turn reply under the inbound message', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = jsonFetch(201, { message: { id: 'msg-ack' } });
    const transport = createLinqTextTransport({
      chatId: CHAT,
      replyToMessageId: 'msg-in-9',
      fetch: fetchMock,
    });

    const sent = await transport.send({ to: '+12025559876', body: 'Done' });

    expect(sent).toEqual({
      providerMessageId: 'msg-ack',
      transport: 'imessage',
      chatId: CHAT,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      message: {
        parts: [{ type: 'text', value: 'Done' }],
        reply_to: { message_id: 'msg-in-9' },
      },
    });
  });

  it('refuses media by name and a turn that arrived without a chat id', async () => {
    const transport = createLinqTextTransport({ chatId: CHAT });
    await expect(
      transport.send({
        to: '+12025559876',
        body: 'card',
        mediaUrls: ['https://example.com/a.vcf'],
      }),
    ).rejects.toMatchObject({ code: 'media_unsupported', permanent: true });

    const unbound = createLinqTextTransport({ chatId: null });
    await expect(unbound.send({ to: '+12025559876', body: 'hi' })).rejects.toMatchObject({
      code: 'missing_chat_id',
    });
  });
});

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

describe('markLinqChatRead', () => {
  it('posts the chat read endpoint and names a missing key', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const fetchMock = vi.fn();
    expect(await markLinqChatRead({ chatId: CHAT, fetch: fetchMock })).toEqual({
      status: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchOk = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? '',
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(null, { status: 204 });
    });
    expect(await markLinqChatRead({ chatId: CHAT, fetch: fetchOk })).toEqual({
      status: 'accepted',
    });
    expect(calls).toEqual([
      {
        url: `https://api.linqapp.com/api/partner/v3/chats/${CHAT}/read`,
        method: 'POST',
        body: undefined,
      },
    ]);
  });

  it('names a refusal and does not throw', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const refused = jsonFetch(404, { error: { code: 2001, message: 'missing chat' } });
    expect(await markLinqChatRead({ chatId: CHAT, fetch: refused })).toEqual({
      status: 'refused',
      code: '2001',
      httpStatus: 404,
      permanent: true,
    });
  });
});

describe('Linq human-feel helpers', () => {
  it('starts and stops typing without a body, and names a missing key', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const fetchMock = vi.fn();
    expect(await startLinqTyping({ chatId: CHAT, fetch: fetchMock })).toEqual({
      status: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchOk = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? '',
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return new Response(null, { status: 204 });
    });
    expect(await startLinqTyping({ chatId: CHAT, fetch: fetchOk })).toEqual({ status: 'accepted' });
    expect(await stopLinqTyping({ chatId: CHAT, fetch: fetchOk })).toEqual({ status: 'accepted' });
    expect(calls).toEqual([
      {
        url: `https://api.linqapp.com/api/partner/v3/chats/${CHAT}/typing`,
        method: 'POST',
        body: undefined,
      },
      {
        url: `https://api.linqapp.com/api/partner/v3/chats/${CHAT}/typing`,
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });

  it('sends a media part, a sole link preview, and a reply-to target', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = jsonFetch(201, { message: { id: 'msg-media' } });
    await sendLinqParts({
      chatId: CHAT,
      parts: [{ type: 'media', url: 'https://example.com/photo.jpg' }],
      replyTo: { messageId: 'msg-in-1', partIndex: 0 },
      fetch: fetchMock,
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      message: {
        parts: [{ type: 'media', url: 'https://example.com/photo.jpg' }],
        reply_to: { message_id: 'msg-in-1', part_index: 0 },
      },
    });

    const link = jsonFetch(201, { message: { id: 'msg-link' } });
    await sendLinqParts({
      chatId: CHAT,
      parts: [{ type: 'link', value: 'https://example.com/camp' }],
      fetch: link,
    });
    expect(JSON.parse(String(link.mock.calls[0]?.[1]?.body))).toEqual({
      message: { parts: [{ type: 'link', value: 'https://example.com/camp' }] },
    });

    await expect(
      sendLinqParts({
        chatId: CHAT,
        parts: [
          { type: 'text', value: 'see' },
          { type: 'link', value: 'https://example.com/camp' },
        ],
        fetch: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'link_not_alone', permanent: true });
  });

  it('adds a tapback and refuses a custom reaction with no emoji', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = jsonFetch(202, { status: 'accepted' });
    await reactToLinqMessage({
      messageId: 'msg-in-1',
      operation: 'add',
      type: 'love',
      fetch: fetchMock,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.linqapp.com/api/partner/v3/messages/msg-in-1/reactions');
    expect(JSON.parse(String(init?.body))).toEqual({ operation: 'add', type: 'love' });

    await expect(
      reactToLinqMessage({
        messageId: 'msg-in-1',
        operation: 'add',
        type: 'custom',
        fetch: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(LinqSendError);
  });

  it('shares a contact card only when called, and posts no body', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    await shareLinqContactCard({ chatId: CHAT, fetch: fetchMock });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.linqapp.com/api/partner/v3/chats/${CHAT}/share_contact_card`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('treats a 2xx share body with success false as a no-op', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async () => Response.json({ success: false, error: { code: 2012 } }));
    await expect(shareLinqContactCard({ chatId: CHAT, fetch: fetchMock })).rejects.toMatchObject({
      code: '2012',
    });
  });

  it('does not treat a setup body without is_active as a live card', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async () => Response.json({}, { status: 201 }));
    const setup = await setupLinqContactCard({
      phoneNumber: '+15555550100',
      firstName: 'Hale',
      imageUrl: 'https://app.villagehale.com/email-logo.png',
      fetch: fetchMock,
    });
    expect(setup).toMatchObject({ status: 'refused', code: 'card_inactive' });
  });
});

describe('Linq group, card, poll, and effect helpers', () => {
  it('creates a group chat without a link in the first text', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        { chat: { id: 'group-chat-1', message: { id: 'msg-created' } } },
        { status: 201 },
      ),
    );
    const created = await createLinqChat({
      from: '+15555550100',
      to: ['+14165550101', '+14165550102'],
      text: "This thread is your kids' year — both of you, and me.",
      fetch: fetchMock,
    });
    expect(created).toEqual({ chatId: 'group-chat-1', providerMessageId: 'msg-created' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      from: '+15555550100',
      to: ['+14165550101', '+14165550102'],
      message: {
        parts: [{ type: 'text', value: "This thread is your kids' year — both of you, and me." }],
      },
    });
    await expect(
      createLinqChat({
        from: '+15555550100',
        to: ['+14165550101'],
        text: 'see https://app.villagehale.com',
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'invalid_parts' });
  });

  it('adds and removes a participant', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({}, { status: 200 }),
    );
    await addLinqParticipant({ chatId: CHAT, handle: '+14165550102', fetch: fetchMock });
    await removeLinqParticipant({ chatId: CHAT, handle: '+14165550102', fetch: fetchMock });
    const add = fetchMock.mock.calls[0];
    const remove = fetchMock.mock.calls[1];
    expect(add?.[0]).toBe(`https://api.linqapp.com/api/partner/v3/chats/${CHAT}/participants`);
    expect(add?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(add?.[1]?.body))).toEqual({ handle: '+14165550102' });
    expect(remove?.[1]?.method).toBe('DELETE');
    expect(JSON.parse(String(remove?.[1]?.body))).toEqual({ handle: '+14165550102' });
  });

  it('names the Hale card and patches when Linq says one is already active', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('/contact_card?')) {
        return Response.json({ is_active: true }, { status: 200 });
      }
      return Response.json({ error: { status: 409, code: 2014 } }, { status: 409 });
    });
    const setup = await setupLinqContactCard({
      phoneNumber: '+15555550100',
      firstName: 'Hale',
      imageUrl: 'https://app.villagehale.com/email-logo.png',
      fetch: fetchMock,
    });
    expect(setup).toEqual({ status: 'accepted' });
    const created = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(created).toEqual({
      first_name: 'Hale',
      phone_number: '+15555550100',
      image_url: 'https://app.villagehale.com/email-logo.png',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PATCH');
  });

  it('sends a poll and a screen effect', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { poll?: unknown; message?: unknown };
      if (body.poll) {
        return Response.json(
          {
            message_id: 'poll-1',
            poll: {
              options: [
                { option_id: 'o1', text: 'Soccer' },
                { option_id: 'o2', text: 'Swim' },
              ],
            },
          },
          { status: 202 },
        );
      }
      return Response.json({ message: { id: 'effect-1' } }, { status: 201 });
    });
    const poll = await sendLinqPoll({
      chatId: CHAT,
      options: ['Soccer', 'Swim'],
      idempotencyKey: 'poll:fam:1',
      fetch: fetchMock,
    });
    expect(poll.messageId).toBe('poll-1');
    expect(poll.options).toEqual([
      { optionId: 'o1', text: 'Soccer' },
      { optionId: 'o2', text: 'Swim' },
    ]);
    const effect = await sendLinqEffect({
      chatId: CHAT,
      text: 'nice',
      effect: { type: 'screen', name: 'confetti' },
      fetch: fetchMock,
    });
    expect(effect.providerMessageId).toBe('effect-1');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      message: {
        parts: [{ type: 'text', value: 'nice' }],
        effect: { type: 'screen', name: 'confetti' },
      },
    });
    const named = await updateLinqGroupChat({
      chatId: CHAT,
      displayName: "Kids' year",
      iconUrl: 'https://app.villagehale.com/email-logo.png',
      fetch: fetchMock,
    });
    expect(named.status).toBe('accepted');
  });
});
