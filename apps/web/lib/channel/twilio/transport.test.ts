import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwilioSendError, createTwilioTransport } from './transport';

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

/** A Twilio refusal, shaped as the provider sends it — the numbers echoed back inside
 * `message` are what must never reach the thrown error (rule #1). */
function refusal(code: number, status: number): Response {
  return new Response(
    JSON.stringify({
      code,
      message: `The message From/To pair (${FROM}/${TO}) was refused.`,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

async function refusedWith(response: Response): Promise<unknown> {
  const transport = createTwilioTransport({
    fetch: (async () => response) as unknown as typeof fetch,
  });
  return transport.send({ to: TO, body: BODY }).catch((error: unknown) => error);
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

  it('asks Twilio for delivery receipts at the status webhook (live-gate finding: the number-level StatusCallback is ignored for API-created messages, so omitting it here means no receipt ever fires)', async () => {
    vi.stubEnv('APP_URL', 'https://app.example.test');
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await transport.send({ to: TO, body: BODY });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('StatusCallback')).toBe('https://app.example.test/api/channels/twilio/status');
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

  it('marks the refusals a retry can only re-earn as PERMANENT, carrying the code and status', async () => {
    for (const code of [21610, 21408, 21211, 21614]) {
      const error = await refusedWith(refusal(code, 400));

      expect(error).toBeInstanceOf(TwilioSendError);
      const twilio = error as TwilioSendError;
      expect([twilio.code, twilio.httpStatus, twilio.permanent]).toEqual([String(code), 400, true]);
    }
  });

  it('leaves a provider outage TRANSIENT, so the queue still retries what a retry can fix', async () => {
    const error = await refusedWith(refusal(20500, 500));

    expect(error).toBeInstanceOf(TwilioSendError);
    const twilio = error as TwilioSendError;
    expect([twilio.code, twilio.httpStatus, twilio.permanent]).toEqual(['20500', 500, false]);
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

describe('media', () => {
  beforeEach(configure);
  afterEach(() => vi.unstubAllEnvs());

  const CARD = 'https://www.villagehale.com/hale.vcf';

  it('carries every media url as its own repeated MediaUrl field', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await transport.send({ to: TO, body: BODY, mediaUrls: [CARD, `${CARD}?two`] });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(init.body as string);
    // Twilio's MediaUrl is repeatable, not comma-joined: getAll, not get.
    expect(sent.getAll('MediaUrl')).toEqual([CARD, `${CARD}?two`]);
    expect(sent.get('Body')).toBe(BODY);
  });

  it('sends no MediaUrl at all when the caller asked for none', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await transport.send({ to: TO, body: BODY });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(init.body as string).getAll('MediaUrl')).toEqual([]);
  });

  it('refuses an empty media array rather than quietly downgrading to a plain SMS', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    const transport = createTwilioTransport({ fetch: fetchMock as unknown as typeof fetch });

    await expect(transport.send({ to: TO, body: BODY, mediaUrls: [] })).rejects.toThrow(
      /mediaUrls/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('types the media-specific refusals as PERMANENT — a card Twilio cannot fetch or carry is not a retry', async () => {
    // 21620 unfetchable MediaUrl, 12300 unsupported content-type, 21623 too many media,
    // 21617 body+media over the size limit: all four are the same message re-sent
    // identically, so a retry can only earn them again.
    for (const code of [21620, 12300, 21623, 21617]) {
      const error = await refusedWith(refusal(code, 400));

      expect(error).toBeInstanceOf(TwilioSendError);
      const twilio = error as TwilioSendError;
      expect([twilio.code, twilio.permanent]).toEqual([String(code), true]);
    }
  });
});

describe('messaging service sender', () => {
  it('sends via MessagingServiceSid when configured, and the bare From otherwise', async () => {
    configure();
    vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', 'MG39e4469dd337f9952f026cbff0e4e964');
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const transport = createTwilioTransport();
    await transport.send({ to: TO, body: BODY });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('MessagingServiceSid')).toBe('MG39e4469dd337f9952f026cbff0e4e964');
    expect(sent.get('From')).toBeNull();
  });
});
