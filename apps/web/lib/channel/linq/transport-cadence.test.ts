import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * VIL-226 · what PROACTIVE_CADENCE adds to the Linq send: a `message.idempotency_key`
 * that names one send, and a rate limit (HTTP 429 or Linq error 1007) that is retryable
 * and honours Retry-After. Unset, the request and the refusal are exactly today's.
 * VIL-611 · the key names the send, never its words: two sends of the same text are two
 * keys, or Linq would drop the second one as a duplicate.
 */

const CHAT = 'chat-under-test';
const API_KEY = 'linq_test_key_not_a_secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

type Sent = { headers: Record<string, string>; body: { message?: Record<string, unknown> } };

function keyOf(call: Sent | undefined): unknown {
  return call?.body.message?.idempotency_key;
}

function linq(replies: Reply[]) {
  const calls: Sent[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)),
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as Reply;
    return Response.json(reply.body, { status: reply.status, headers: reply.headers });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const OK: Reply = { status: 201, body: { message: { id: 'msg-out-1' } } };
const RATE_LIMITED: Reply = {
  status: 429,
  body: { error: { code: 429 } },
  headers: { 'retry-after': '0' },
};
const LINQ_1007: Reply = { status: 400, body: { error: { code: 1007 } } };

describe('the Linq send while PROACTIVE_CADENCE is unset', () => {
  it('carries no idempotency key and does not retry a 429', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const { calls, fetchImpl } = linq([RATE_LIMITED, OK]);
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: '429', permanent: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['Idempotency-Key']).toBeUndefined();
    expect(calls[0]?.body.message).not.toHaveProperty('idempotency_key');
  });

  it('keeps Linq 1007 a permanent refusal, as today', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const { fetchImpl } = linq([LINQ_1007]);
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: '1007', permanent: true });
  });
});

describe('the Linq send while PROACTIVE_CADENCE is armed', () => {
  it('gives two sends of the same text into the same chat two keys', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const { calls, fetchImpl } = linq([OK]);
    await sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl });
    await sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl });
    expect(keyOf(calls[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
  });

  it("keys a caller's send by its own id, so a retry of that send is the same key", async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const { calls, fetchImpl } = linq([OK]);
    const send = (sendKey: string) =>
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', sendKey, fetch: fetchImpl });
    await send('ledger-row-1');
    await send('ledger-row-1');
    await send('ledger-row-2');
    expect(keyOf(calls[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]));
    expect(keyOf(calls[0])).not.toContain('ledger-row-1');
  });

  it('gives the plain resend after a refused thread target its own key', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { calls, fetchImpl } = linq([{ status: 400, body: { error: { code: 2001 } } }, OK]);
    await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Saturday works',
      replyTo: { messageId: 'in-1' },
      sendKey: 'ledger-row-1',
      fetch: fetchImpl,
    });
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
  });

  it('retries a 429 once when Retry-After allows, with the same key', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { calls, fetchImpl } = linq([RATE_LIMITED, OK]);
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl }),
    ).resolves.toEqual({ providerMessageId: 'msg-out-1' });
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it('makes 1007 retryable and hands a long Retry-After back instead of waiting', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { calls, fetchImpl } = linq([{ ...LINQ_1007, headers: { 'retry-after': '30' } }]);
    const refusal = await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Saturday works',
      fetch: fetchImpl,
    }).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(LinqSendError);
    expect(refusal).toMatchObject({ code: '1007', permanent: false, retryAfterMs: 30_000 });
    expect(calls).toHaveLength(1);
  });
});
