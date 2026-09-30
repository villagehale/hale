import { afterEach, describe, expect, it, vi } from 'vitest';
import { postWorkerOpsSlack } from './ops-slack.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('postWorkerOpsSlack', () => {
  it('names a missing webhook and does not fetch', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
    const fetchImpl = vi.fn();
    await expect(postWorkerOpsSlack('hello', fetchImpl)).resolves.toBe('skipped_not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the text and does not include a phone number', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    await expect(postWorkerOpsSlack('Hale ops: family over ceiling', fetchImpl)).resolves.toBe(
      'sent',
    );
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Hale ops: family over ceiling');
    expect(body).not.toMatch(/\+\d{10}/);
    expect(JSON.parse(body).channel).toBe('C0C5XMCAQ56');
  });
});
