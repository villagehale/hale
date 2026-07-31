import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTwilioTransport } from './transport';

/**
 * The provider leg, against a fake fetch. No network, no credentials, no SDK — the
 * assertions are on the exact request Twilio would receive and on what never leaves
 * the process (the number, the body, the secret).
 */

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const API_KEY_SID = 'SK11111111111111111111111111111111';
const API_KEY_SECRET = 'super_secret_value';
const FROM = '+14165550000';
const TO = '+14165551234';
const BODY = 'Two kids, 3 and 6 — got it.';

function configure(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'auth_token_value');
  vi.stubEnv('TWILIO_API_KEY_SID', API_KEY_SID);
  vi.stubEnv('TWILIO_API_KEY_SECRET', API_KEY_SECRET);
  vi.stubEnv('TWILIO_FROM_NUMBER', FROM);
}

function okResponse(sid = 'SM99999999999999999999999999999999'): Response {
  return new Response(JSON.stringify({ sid, status: 'queued' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createTwilioTransport', () => {
  beforeEach(configure);
  afterEach(() => vi.unstubAllEnvs());

  it('POSTs the message to the account Messages endpoint and returns the provider sid', async () => {
    const fetchMock = vi.fn(async () => okResponse('SM_ABC'));
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    const result = await transport.send({ to: TO, body: BODY });

    expect(result).toEqual({ providerMessageId: 'SM_ABC' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('To')).toBe(TO);
    expect(sent.get('From')).toBe(FROM);
    expect(sent.get('Body')).toBe(BODY);
  });

  it('authenticates with the API KEY pair (not the auth token) over HTTP Basic', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await transport.send({ to: TO, body: BODY });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const auth = new Headers(init.headers).get('authorization') ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8')).toBe(
      `${API_KEY_SID}:${API_KEY_SECRET}`,
    );
  });

  it('throws naming the missing env vars — never a value — when unconfigured', async () => {
    vi.stubEnv('TWILIO_API_KEY_SECRET', '');
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await expect(transport.send({ to: TO, body: BODY })).rejects.toThrow(
      /missing TWILIO_API_KEY_SECRET/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a provider error carrying only the status and Twilio error code', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 21610,
            message: `The message From/To pair (${FROM}/${TO}) violates a blacklist rule.`,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    const err = await transport.send({ to: TO, body: BODY }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('400');
    expect(message).toContain('21610');
    // The provider echoes the numbers back inside `message`; re-throwing that would
    // put a parent's phone number into a stack trace and the platform log (rule #1).
    expect(message).not.toContain(TO);
    expect(message).not.toContain(FROM);
  });

  it('throws rather than inventing an id when the provider returns no sid', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'queued' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await expect(transport.send({ to: TO, body: BODY })).rejects.toThrow(/no message sid/);
  });

  it('never logs the recipient, the body, or the API key secret', async () => {
    const logs: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(...args);
      });
    }
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await transport.send({ to: TO, body: BODY });

    const written = JSON.stringify(logs);
    expect(written).not.toContain(TO);
    expect(written).not.toContain(BODY);
    expect(written).not.toContain(API_KEY_SECRET);
    vi.restoreAllMocks();
  });
});
