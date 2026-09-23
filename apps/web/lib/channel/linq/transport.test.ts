import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LinqSendError,
  createLinqTextTransport,
  reactToLinqMessage,
  sendLinqChatMessage,
  sendLinqParts,
  shareLinqContactCard,
  startLinqTyping,
  stopLinqTyping,
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
});

describe('createLinqTextTransport', () => {
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
});
