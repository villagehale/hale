import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linqRefusedForCertainEnabled } from './config';
import { LinqSendError, linqRefusedForCertain, sendLinqChatMessage } from './transport';

const FLAG = 'LINQ_REFUSED_FOR_CERTAIN_ENABLED';
const API_KEY = 'linq_test_key_not_a_secret';
const ACCEPTED = { message: { id: 'out-accepted' } };

beforeEach(() => {
  vi.stubEnv('LINQ_API_KEY', API_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function failureOf(fetchImpl: typeof fetch, text = 'Saturday works'): Promise<unknown> {
  return sendLinqChatMessage({ chatId: 'chat-test', text, fetch: fetchImpl }).then(
    () => {
      throw new Error('the send was expected to fail');
    },
    (err: unknown) => err,
  );
}

const answering = (status: number, body: unknown = { error: { code: status } }) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('linqRefusedForCertain', () => {
  it.each([400, 401, 403, 404, 422])('a %i proves Linq refused the text', async (status) => {
    expect(linqRefusedForCertain(await failureOf(answering(status)))).toBe(true);
  });

  it.each([408, 409, 418, 425, 429, 500, 502, 503])(
    'a %i does not prove the text stayed home',
    async (status) => {
      const err = await failureOf(answering(status));
      expect(err).toBeInstanceOf(LinqSendError);
      expect(linqRefusedForCertain(err)).toBe(false);
    },
  );

  it('a 2xx with no message id does not prove it either', async () => {
    const err = await failureOf(answering(201, {}));
    expect(err).toMatchObject({ code: 'missing_message_id' });
    expect(linqRefusedForCertain(err)).toBe(false);
  });

  it('a rate-limit code on a 400 is not a refusal of this text', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const err = await failureOf(answering(400, { error: { code: 1007 } }));
    expect(err).toMatchObject({ code: '1007', httpStatus: 400, permanent: false });
    expect(linqRefusedForCertain(err)).toBe(false);
  });

  it('a timeout and a network error share status 0 with a pre-fetch refusal, and stay unproven', async () => {
    const aborted = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const timeout = await failureOf(aborted);
    const network = await failureOf(offline);

    expect(timeout).toMatchObject({ code: 'timeout', httpStatus: 0 });
    expect(network).toMatchObject({ code: 'network', httpStatus: 0 });
    expect(linqRefusedForCertain(timeout)).toBe(false);
    expect(linqRefusedForCertain(network)).toBe(false);
  });

  it('a refusal raised before any fetch is certain', async () => {
    vi.stubEnv('LINQ_API_KEY', '');
    const never = vi.fn() as unknown as typeof fetch;

    const err = await failureOf(never);

    expect(err).toMatchObject({ code: 'not_configured', httpStatus: 0, permanent: true });
    expect(never).not.toHaveBeenCalled();
    expect(linqRefusedForCertain(err)).toBe(true);
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['null', null],
    [
      'a look-alike that is not a LinqSendError',
      { code: 'http_400', httpStatus: 400, permanent: true },
    ],
  ])('%s is not a refusal', (_name, err) => {
    expect(linqRefusedForCertain(err)).toBe(false);
  });
});

describe('LINQ_REFUSED_FOR_CERTAIN_ENABLED', () => {
  it('is on only for the exact value true', () => {
    vi.stubEnv(FLAG, 'true');
    expect(linqRefusedForCertainEnabled()).toBe(true);
    for (const value of ['', 'TRUE', 'true\n', ' true', '1', 'on', 'false']) {
      vi.stubEnv(FLAG, value);
      expect(linqRefusedForCertainEnabled()).toBe(false);
    }
  });
});

describe('another lane with the flag on', () => {
  async function threadedSendAfter409() {
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return requests.length === 1
        ? Response.json({ error: { code: 409 } }, { status: 409 })
        : Response.json(ACCEPTED, { status: 201 });
    }) as unknown as typeof fetch;
    await sendLinqChatMessage({
      chatId: 'chat-test',
      text: 'Saturday works',
      replyTo: { messageId: 'in-1' },
      sendKey: 'reply-key',
      fetch: fetchImpl,
    });
    return requests;
  }

  it('keeps the same requests and the same retry count as with it off', async () => {
    vi.stubEnv(FLAG, 'false');
    const off = await threadedSendAfter409();
    vi.stubEnv(FLAG, 'true');
    const on = await threadedSendAfter409();

    expect(off).toHaveLength(2);
    expect(on).toEqual(off);
  });
});
