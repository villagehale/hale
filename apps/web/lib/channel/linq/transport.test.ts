import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError, createLinqTextTransport, sendLinqChatMessage } from './transport';

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
