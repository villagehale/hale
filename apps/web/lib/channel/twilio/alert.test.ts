import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_SLACK_CHANNEL_DEFAULT } from '~/lib/monitoring/ops-slack';
import {
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
 * the 500s were. The fetch is injected, so what Slack and PostHog would have received
 * is asserted directly — including what is NOT in it (rule #1). Founder SMS is not a
 * leg: a configured FOUNDER_ALERT_PHONE must not produce a Twilio request.
 */

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'twilio_auth_token_value';
const FOUNDER_PHONE = '+14165550111';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const POSTHOG_KEY = 'phc_test_key';
const POSTHOG_HOST = 'https://ph.example.com';

function configure(): void {
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.stubEnv('FOUNDER_ALERT_PHONE', FOUNDER_PHONE);
  vi.stubEnv('TWILIO_ACCOUNT_SID', ACCOUNT_SID);
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', POSTHOG_KEY);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', POSTHOG_HOST);
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(respond: () => Promise<Response> = async () => new Response('ok')): {
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

const slackCall = (calls: Call[]) => calls.filter((call) => call.url === WEBHOOK);
const posthogCall = (calls: Call[]) => calls.filter((call) => call.url.startsWith(POSTHOG_HOST));
const twilioCall = (calls: Call[]) => calls.filter((call) => call.url.includes('api.twilio.com'));

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

function pageText(calls: Call[]): string {
  const posted = JSON.parse(only(slackCall(calls), 'slack').body) as {
    text?: string;
    channel?: string;
  };
  expect(posted.channel).toBe(OPS_SLACK_CHANNEL_DEFAULT);
  return posted.text ?? '';
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
  it('pages Slack #ops and captures the failure, naming the route and the error class', async () => {
    configure();
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new TypeError('fetch failed: db.supabase.co') },
      { fetch },
    );

    expect(outcome).toEqual({ page: 'sent', analytics: 'sent' });
    expect(twilioCall(calls)).toHaveLength(0);

    const slack = only(slackCall(calls), 'slack');
    expect(slack.headers['content-type']).toBe('application/json');
    const text = pageText(calls);
    expect(text).toContain('twilio_inbound');
    expect(text).toContain('TypeError');
    expect(text).not.toContain('fetch failed');
    expect(text).not.toContain(FOUNDER_PHONE);

    const captured = only(posthogCall(calls), 'posthog');
    expect(captured.url).toBe(`${POSTHOG_HOST}/i/v0/e/`);
    expect(JSON.parse(captured.body)).toEqual({
      api_key: POSTHOG_KEY,
      event: 'webhook_route_failed',
      distinct_id: 'route:twilio_inbound',
      properties: { route: 'twilio_inbound', error_class: 'TypeError' },
    });
  });

  /** The boundary is the SEAM'S, not Twilio's: the email door alerts through the same
   * two legs under its own route token (audit P1-5a). */
  it('names the email door with its own route token', async () => {
    configure();
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'email_inbound', error: new TypeError('fetch failed: db.supabase.co') },
      { fetch },
    );

    expect(outcome).toEqual({ page: 'sent', analytics: 'sent' });
    expect(pageText(calls)).toBe(
      'Hale ALERT: email_inbound threw - TypeError. Details in logs + PostHog.',
    );
    expect(JSON.parse(only(posthogCall(calls), 'posthog').body)).toMatchObject({
      distinct_id: 'route:email_inbound',
      properties: { route: 'email_inbound', error_class: 'TypeError' },
    });
  });

  it('sends no parent phone number and no message body to either leg', async () => {
    configure();
    const { calls, fetch } = recorder();

    await webhookFailureAlert(
      {
        route: 'twilio_inbound',
        // Parent text AND a separator-formatted number a digit-run scrub would miss —
        // the error MESSAGE must simply never reach a leg.
        error: new Error(
          'insert into channel_messages failed for +14165551234: is Nora ok? call 416-555-1234',
        ),
      },
      { fetch },
    );

    const body = pageText(calls);
    expect(body).not.toContain('14165551234');
    expect(body).not.toContain('Nora');
    expect(body).not.toContain('416-555');
    expect(body).not.toContain('insert into channel_messages');
    expect(body).toContain('twilio_inbound');
    expect(body).toContain('Error');

    const properties = JSON.parse(only(posthogCall(calls), 'posthog').body).properties as Record<
      string,
      unknown
    >;
    expect(properties).toEqual({ route: 'twilio_inbound', error_class: 'Error' });
    expect(JSON.stringify(properties)).not.toContain('Nora');
  });

  it('stays a short class-only page no matter how long the error message is', async () => {
    configure();
    const { calls, fetch } = recorder();

    await webhookFailureAlert(
      { route: 'twilio_status', error: new Error('x'.repeat(500)) },
      { fetch },
    );

    const body = pageText(calls);
    expect(body).not.toContain('xxx');
    expect(body.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]*$/.test(body)).toBe(true);
  });

  it('names a missing OPS_SLACK_WEBHOOK_URL and does not text the founder phone', async () => {
    configure();
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_voice', error: new Error('boom') },
      { fetch },
    );

    expect(outcome.page).toBe('skipped_not_configured');
    expect(console.error).toHaveBeenCalled();
    expect(slackCall(calls)).toHaveLength(0);
    expect(twilioCall(calls)).toHaveLength(0);
    expect(outcome.analytics).toBe('sent');
    expect(posthogCall(calls)).toHaveLength(1);
  });

  it('still pages Slack when Twilio credentials are absent', async () => {
    configure();
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    const { calls, fetch } = recorder();

    const outcome = await webhookFailureAlert(
      { route: 'twilio_inbound', error: new Error('boom') },
      { fetch },
    );

    expect(outcome.page).toBe('sent');
    expect(pageText(calls)).toContain('twilio_inbound');
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

    expect(outcome).toEqual({ page: 'sent', analytics: 'skipped_not_configured' });
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

    expect(outcome).toEqual({ page: 'failed', analytics: 'failed' });
    expect(slackCall(calls)).toHaveLength(1);
    expect(twilioCall(calls)).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('never throws out of the reporter when the network itself is gone', async () => {
    configure();
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(
      webhookFailureAlert({ route: 'twilio_inbound', error: new Error('boom') }, { fetch }),
    ).resolves.toEqual({ page: 'failed', analytics: 'failed' });
  });

  it('suppresses the second founder page inside 15 minutes but still captures every failure', async () => {
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

    expect(first.page).toBe('sent');
    expect(second.page).toBe('suppressed_rate_limit');
    expect(slackCall(calls)).toHaveLength(1);
    expect(second.analytics).toBe('sent');
    expect(posthogCall(calls)).toHaveLength(2);
  });

  it('reopens the founder page window once 15 minutes have passed', async () => {
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

    expect(later.page).toBe('sent');
    expect(slackCall(calls)).toHaveLength(2);
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

    expect(first.page).toBe('failed');
    expect(second.page).toBe('suppressed_rate_limit');
    expect(slackCall(calls)).toHaveLength(1);
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
    expect(slackCall(calls)).toHaveLength(1);
    expect(twilioCall(calls)).toHaveLength(0);
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
