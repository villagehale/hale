import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * VIL-226 · what PROACTIVE_CADENCE adds to the Linq send: an Idempotency-Key on every
 * send, and a rate limit (HTTP 429 or Linq error 1007) that is retryable and honours
 * Retry-After. Unset, the request and the refusal are exactly today's.
 */

const CHAT = 'chat-under-test';
const API_KEY = 'linq_test_key_not_a_secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function linq(replies: Reply[]) {
  const calls: Array<{ headers: Record<string, string>; body: unknown }> = [];
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
  it('carries no Idempotency-Key and does not retry a 429', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const { calls, fetchImpl } = linq([RATE_LIMITED, OK]);
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: '429', permanent: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['Idempotency-Key']).toBeUndefined();
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
  it('sends one stable Idempotency-Key per chat and message', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const { calls, fetchImpl } = linq([OK]);
    await sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl });
    await sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl });
    await sendLinqChatMessage({ chatId: CHAT, text: 'Sunday works', fetch: fetchImpl });
    const keys = calls.map((call) => call.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('gives the plain resend after a refused thread target its own key', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { calls, fetchImpl } = linq([{ status: 400, body: { error: { code: 2001 } } }, OK]);
    await sendLinqChatMessage({
      chatId: CHAT,
      text: 'Saturday works',
      replyTo: { messageId: 'in-1' },
      fetch: fetchImpl,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Idempotency-Key']).not.toBe(calls[0]?.headers['Idempotency-Key']);
  });

  it('retries a 429 once when Retry-After allows, with the same key', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { calls, fetchImpl } = linq([RATE_LIMITED, OK]);
    await expect(
      sendLinqChatMessage({ chatId: CHAT, text: 'Saturday works', fetch: fetchImpl }),
    ).resolves.toEqual({ providerMessageId: 'msg-out-1' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Idempotency-Key']).toBe(calls[0]?.headers['Idempotency-Key']);
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
