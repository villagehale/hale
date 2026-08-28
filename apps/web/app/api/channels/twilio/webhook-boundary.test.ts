import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetWebhookAlertWindowForTests } from '~/lib/channel/twilio/alert';

/**
 * VIL-331 — what the three Twilio route shells do when the thing under them throws.
 *
 * On 2026-08-28 the FIRST database call behind the inbound webhook threw for six hours.
 * The shell had no catch, so Next answered an anonymous 500, Twilio logged error 11200,
 * and four parents' texts were dropped in silence. Two things have to be true afterwards
 * and both are asserted here per route: the answer is still a 5xx (Twilio's
 * SmsFallbackUrl retries on nothing else — a 200 would trade a visible failure for a
 * permanently lost message), and somebody is told.
 *
 * The alert module is NOT mocked: `fetch` is, so what Twilio and PostHog would have
 * received is asserted through the real reporter. What IS mocked is everything that
 * needs infrastructure — the point of a shell is that it holds no logic of its own.
 */

const handleInbound = vi.fn();
const handleVoice = vi.fn();
const handleStatus = vi.fn();
const inboundDeps = vi.fn();

vi.mock('~/lib/channel/twilio/inbound', () => ({
  handleTwilioInboundRequest: (...args: unknown[]) => handleInbound(...args),
}));
vi.mock('~/lib/channel/twilio/voice', () => ({
  handleTwilioVoiceRequest: (...args: unknown[]) => handleVoice(...args),
}));
vi.mock('~/lib/channel/twilio/status', () => ({
  handleTwilioStatusRequest: (...args: unknown[]) => handleStatus(...args),
}));
vi.mock('~/lib/channel/twilio/deps', () => ({
  twilioInboundDeps: () => inboundDeps(),
  twilioVoiceDeps: () => ({}),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: async () => {} }));

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const FOUNDER_PHONE = '+14165550111';
const POSTHOG_HOST = 'https://ph.example.com';

const calls: { url: string; body: string }[] = [];

function request(): Request {
  return new Request('https://app.example.com/api/channels/twilio/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'From=%2B14165551234&Body=is+Nora+ok%3F',
  });
}

const twilioCalls = () => calls.filter((call) => call.url.includes('api.twilio.com'));
const posthogCalls = () => calls.filter((call) => call.url.startsWith(POSTHOG_HOST));

/** The single request of its kind, or a thrown failure — never an optional-chained
 * `undefined` that would let a "must not contain" assertion pass on a request that was
 * never made. */
function only(of: { url: string; body: string }[], label: string): { url: string; body: string } {
  const [first, ...rest] = of;
  if (!first || rest.length > 0) {
    throw new Error(`expected exactly one ${label} request, saw ${of.length}`);
  }
  return first;
}

const smsBody = () => new URLSearchParams(only(twilioCalls(), 'twilio').body).get('Body') ?? '';
const captured = () => JSON.parse(only(posthogCalls(), 'posthog').body);

beforeEach(() => {
  calls.length = 0;
  resetWebhookAlertWindowForTests();
  handleInbound.mockReset();
  handleVoice.mockReset();
  handleStatus.mockReset();
  inboundDeps.mockReset().mockReturnValue({ enqueue: async () => {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'twilio_auth_token_value');
  vi.stubEnv('FOUNDER_ALERT_PHONE', FOUNDER_PHONE);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', POSTHOG_HOST);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response('{}');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/channels/twilio/inbound', () => {
  it('answers 500 and pages the founder when the handler throws', async () => {
    const { POST } = await import('./inbound/route');
    handleInbound.mockRejectedValue(new Error('sorry, too many clients already'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
    expect(twilioCalls()).toHaveLength(1);
    expect(smsBody()).toContain('twilio_inbound');
    expect(smsBody()).not.toContain('too many clients');
    expect(captured()).toMatchObject({
      event: 'webhook_route_failed',
      properties: { route: 'twilio_inbound', error_class: 'Error' },
    });
  });

  it('alerts when the DEPENDENCIES throw, which is where the outage actually hit', async () => {
    const { POST } = await import('./inbound/route');
    // db() itself, before a single line of the handler ran — the shape of 2026-08-28.
    inboundDeps.mockImplementation(() => {
      throw new Error('getaddrinfo ENOTFOUND db.supabase.co');
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(twilioCalls()).toHaveLength(1);
    expect(posthogCalls()).toHaveLength(1);
  });

  it('carries no parent phone number and no message text into the alert', async () => {
    const { POST } = await import('./inbound/route');
    handleInbound.mockRejectedValue(
      new Error('insert into channel_messages failed for +14165551234: is Nora ok?'),
    );

    await POST(request());

    expect(smsBody()).not.toContain('14165551234');
    expect(smsBody()).not.toContain('Nora');
    expect(smsBody()).not.toContain('insert into channel_messages');
    expect(captured().properties).toEqual({
      route: 'twilio_inbound',
      error_class: 'Error',
    });
  });

  it('returns the handler’s own answer and alerts nobody on a healthy request', async () => {
    const { POST } = await import('./inbound/route');
    handleInbound.mockResolvedValue(new Response('<Response/>', { status: 200 }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response/>');
    expect(calls).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('POST /api/channels/twilio/voice', () => {
  it('answers 500 and names its own route in the alert', async () => {
    const { POST } = await import('./voice/route');
    handleVoice.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(smsBody()).toContain('twilio_voice');
    expect(captured().properties.route).toBe('twilio_voice');
  });
});

describe('POST /api/channels/twilio/status', () => {
  it('answers 500 and names its own route in the alert', async () => {
    const { POST } = await import('./status/route');
    handleStatus.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(smsBody()).toContain('twilio_status');
    expect(captured().properties.route).toBe('twilio_status');
  });
});
