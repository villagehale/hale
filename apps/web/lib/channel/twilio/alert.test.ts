import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_FROM_NUMBER,
  resetWebhookAlertWindowForTests,
  webhookFailureAlert,
  withWebhookFailureAlert,
} from './alert';

/**
 * VIL-331 — the alert that exists for the moment nothing else works.
 *
 * Every assertion here is about a request that leaves the instance WITHOUT a database:
 * the 2026-08-28 incident made the first query in routeTwilioInbound throw for six
 * hours, and an alert that needed a row to be written would have been just as silent as
 * the 500s were. The fetch is injected, so what Twilio and PostHog would have received
 * is asserted directly — including what is NOT in it (rule #1).
 */

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'twilio_auth_token_value';
const FOUNDER_PHONE = '+14165550111';
const POSTHOG_KEY = 'phc_test_key';
const POSTHOG_HOST = 'https://ph.example.com';

function configure(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('FOUNDER_ALERT_PHONE', FOUNDER_PHONE);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', POSTHOG_KEY);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', POSTHOG_HOST);
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(respond: () => Promise<Response> = async () => new Response('{}')): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  const record: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return respond();
  };
  return { calls, fetch: record };
}

const twilioCall = (calls: Call[]) => calls.filter((call) => call.url.includes('api.twilio.com'));
const posthogCall = (calls: Call[]) => calls.filter((call) => call.url.startsWith(POSTHOG_HOST));

/** The single request of its kind, or a thrown failure — never an optional-chained
 * `undefined` that would let a "must not contain" assertion pass on a request that was
 * never made. */
function only(calls: Call[], label: string): Call {
  const [first, ...rest] = calls;
  if (!first || rest.length > 0) {
    throw new Error(`expected exactly one ${label} request, saw ${calls.length}`);
  }
  return first;
}

beforeEach(() => {
  resetWebhookAlertWindowForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('webhookFailureAlert', () => {
  it('texts the founder and captures the failure, naming the route and the error class', async () => {
    configure();
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new TypeError('fetch failed: db.supabase.co') },
      { fetch },
    );

    expect(outcome).toEqual({ sms: 'sent', analytics: 'sent' });

    const sms = only(twilioCall(calls), 'twilio');
    expect(sms.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(sms.headers.authorization).toBe(
      `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
    );
    const form = new URLSearchParams(sms.body);
    expect(form.get('To')).toBe(FOUNDER_PHONE);
    expect(form.get('From')).toBe(ALERT_FROM_NUMBER);
    expect(form.get('Body')).toContain('twilio_inbound');
    expect(form.get('Body')).toContain('TypeError');
    expect(form.get('Body')).toContain('fetch failed');

    const captured = only(posthogCall(calls), 'posthog');
    expect(captured.url).toBe(`${POSTHOG_HOST}/i/v0/e/`);
    expect(JSON.parse(captured.body)).toEqual({
      api_key: POSTHOG_KEY,
      event: 'webhook_route_failed',
      distinct_id: 'route:twilio_inbound',
      properties: { route: 'twilio_inbound', error_class: 'TypeError' },
    });
  });

  it('sends no parent phone number and no message body to either leg', async () => {
    configure();
    const { calls, fetch } = recorder();

    await webhookFailureAlert(
      {
        route: 'twilio_inbound',
        error: new Error('insert into channel_messages failed for +14165551234: is Nora ok?'),
      },
      { fetch },
    );

    const body = new URLSearchParams(only(twilioCall(calls), 'twilio').body).get('Body') ?? '';
    expect(body).not.toContain('14165551234');
    expect(body).toContain('[redacted]');
    // The founder still learns WHICH statement broke — the scrub takes the digits, not
    // the diagnosis.
    expect(body).toContain('insert into channel_messages failed');

    const properties = JSON.parse(only(posthogCall(calls), 'posthog').body).properties as Record<
      string,
      unknown
    >;
    expect(properties).toEqual({ route: 'twilio_inbound', error_class: 'Error' });
    expect(JSON.stringify(properties)).not.toContain('Nora');
  });

  it('truncates a long error message rather than sending an essay', async () => {
    configure();
    const { calls, fetch } = recorder();

    await webhookFailureAlert(
      { route: 'twilio_status', error: new Error('x'.repeat(500)) },
      { fetch },
    );

    const body = new URLSearchParams(only(twilioCall(calls), 'twilio').body).get('Body') ?? '';
    expect(body.length).toBeLessThan(220);
    expect(body).toContain('…');
  });

  it('names a missing FOUNDER_ALERT_PHONE instead of skipping in silence', async () => {
    configure();
    vi.stubEnv('FOUNDER_ALERT_PHONE', '');
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_voice', error: new Error('boom') },
      { fetch },
    );

    expect(outcome.sms).toBe('skipped_not_configured');
    expect(console.error).toHaveBeenCalled();
    expect(twilioCall(calls)).toHaveLength(0);
    // The other leg is independent: an unconfigured phone must not cost the event too.
    expect(outcome.analytics).toBe('sent');
    expect(posthogCall(calls)).toHaveLength(1);
  });

  it('names missing Twilio credentials the same way', async () => {
    configure();
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );

    expect(outcome.sms).toBe('skipped_not_configured');
    expect(twilioCall(calls)).toHaveLength(0);
  });

  it('names a missing PostHog key rather than reporting a capture that never happened', async () => {
    configure();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );

    expect(outcome).toEqual({ sms: 'sent', analytics: 'skipped_not_configured' });
    expect(console.error).toHaveBeenCalled();
    expect(posthogCall(calls)).toHaveLength(0);
  });

  it('reports a refused send as failed, not as sent', async () => {
    configure();
    const { calls, fetch } = recorder(async () => new Response('nope', { status: 401 }));

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );

    expect(outcome).toEqual({ sms: 'failed', analytics: 'failed' });
    expect(twilioCall(calls)).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('never throws out of the reporter when the network itself is gone', async () => {
    configure();
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(
      webhookFailureAlert({ route: 'twilio_inbound', error: new Error('boom') }, { fetch }),
    ).resolves.toEqual({ sms: 'failed', analytics: 'failed' });
  });

  it('suppresses the second founder SMS inside 15 minutes but still captures every failure', async () => {
    configure();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
    const { calls, fetch } = recorder();

    const first = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );
    vi.setSystemTime(new Date('2026-08-28T09:14:59.000Z'));
    const second = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom again') },
      { fetch },
    );

    expect(first.sms).toBe('sent');
    expect(second.sms).toBe('suppressed_rate_limit');
    expect(twilioCall(calls)).toHaveLength(1);
    // Not rate limited: the event stream is the audit, and it is what says a six-hour
    // outage was six hours long.
    expect(second.analytics).toBe('sent');
    expect(posthogCall(calls)).toHaveLength(2);
  });

  it('reopens the founder SMS window once 15 minutes have passed', async () => {
    configure();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
    const { calls, fetch } = recorder();

    await webhookFailureAlert({ route: 'twilio_inbound', error: new Error('boom') }, { fetch });
    vi.setSystemTime(new Date('2026-08-28T09:15:01.000Z'));
    const later = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('still boom') },
      { fetch },
    );

    expect(later.sms).toBe('sent');
    expect(twilioCall(calls)).toHaveLength(2);
  });

  it('spends its once-per-window attempt even when the send fails, so an outage cannot log 400 times', async () => {
    configure();
    const { calls, fetch } = recorder(async () => new Response('nope', { status: 500 }));

    const first = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );
    const second = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );

    expect(first.sms).toBe('failed');
    expect(second.sms).toBe('suppressed_rate_limit');
    expect(twilioCall(calls)).toHaveLength(1);
  });
});

describe('withWebhookFailureAlert', () => {
  it('answers 500 and alerts when the handler throws', async () => {
    configure();
    const { calls, fetch } = recorder();

    const response = await withWebhookFailureAlert(
      'twilio_inbound',
      async () => {
        throw new Error('sorry, too many clients already');
      },
      { fetch },
    );

    // Twilio's SmsFallbackUrl retry only fires on a 5xx — a swallowed failure would
    // drop the parent's text for good.
    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
    expect(twilioCall(calls)).toHaveLength(1);
    expect(posthogCall(calls)).toHaveLength(1);
  });

  it('returns the handler’s own response untouched when nothing throws', async () => {
    configure();
    const { calls, fetch } = recorder();

    const response = await withWebhookFailureAlert(
      'twilio_inbound',
      async () => new Response('<Response/>', { status: 200 }),
      { fetch },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response/>');
    expect(calls).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});
