import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_SLACK_CHANNEL_DEFAULT, opsSlackMissing, postOpsSlack } from './ops-slack';

/**
 * Service alerts page Slack #ops. The founder phone is not a configuration of this
 * module: a set FOUNDER_ALERT_PHONE must not produce a Twilio request, and a missing
 * webhook is a named skip rather than a fallback SMS.
 */

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret';

interface Call {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function recorder(status = 200): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(status === 200 ? 'ok' : 'nope', { status });
  };
  return { calls, fetch: fetchImpl };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('postOpsSlack', () => {
  it('posts the alert text to #ops and does not call Twilio', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    vi.stubEnv('FOUNDER_ALERT_PHONE', '+14165550111');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
    const { calls, fetch } = recorder();

    const outcome = await postOpsSlack('Hale: inbound webhook failing. 2 alerts.', fetch);

    expect(outcome).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      text: 'Hale: inbound webhook failing. 2 alerts.',
      channel: OPS_SLACK_CHANNEL_DEFAULT,
    });
    expect(calls[0]?.url).not.toContain('api.twilio.com');
    expect(calls[0]?.body).not.toContain('+14165550111');
  });

  it('honors SLACK_OPS_CHANNEL when set', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    vi.stubEnv('SLACK_OPS_CHANNEL', 'C0OVERRIDE');
    const { calls, fetch } = recorder();

    await postOpsSlack('hello', fetch);

    expect(JSON.parse(calls[0]?.body ?? '')).toMatchObject({ channel: 'C0OVERRIDE' });
  });

  it('names a missing webhook and sends nothing', async () => {
    vi.stubEnv('FOUNDER_ALERT_PHONE', '+14165550111');
    const { calls, fetch } = recorder();

    const outcome = await postOpsSlack('Hale ALERT', fetch);

    expect(outcome).toBe('skipped_not_configured');
    expect(opsSlackMissing()).toEqual(['OPS_SLACK_WEBHOOK_URL']);
    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('refuses a non-https webhook URL instead of posting the alert elsewhere', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'http://hooks.slack.com/services/T/B/X');
    const { calls, fetch } = recorder();

    expect(await postOpsSlack('Hale ALERT', fetch)).toBe('skipped_not_configured');
    expect(calls).toHaveLength(0);
  });

  it('reports a refused webhook as failed', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    const { calls, fetch } = recorder(403);

    expect(await postOpsSlack('Hale ALERT', fetch)).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('never throws when the network is gone', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    const fetchImpl: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    await expect(postOpsSlack('Hale ALERT', fetchImpl)).resolves.toBe('failed');
  });
});
