import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads db + queue at request time. We stub those edges so the test
// exercises the route's dispatch (unknown→404, scaffold→501, live-unconfigured
// →501) and the never-ingest guarantee — not real infra. The per-provider logic
// is covered separately in registry.test.
const sendMock = vi.fn();
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: sendMock }) }));

function ctx(provider: string) {
  return { params: Promise.resolve({ provider }) };
}

async function callPost(provider: string, body = '{}', headers: Record<string, string> = {}) {
  const { POST } = await import('~/app/api/webhooks/[provider]/route');
  const req = new Request('http://localhost/api/webhooks/x', {
    method: 'POST',
    body,
    headers,
  });
  return POST(req as never, ctx(provider));
}

describe('POST /api/webhooks/:provider — registry dispatch', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for an unknown provider', async () => {
    const res = await callPost('facebook');
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each(['brightwheel', 'himama', 'google_classroom'])(
    'returns 501 for scaffold provider %s and never enqueues an event',
    async (provider) => {
      // Even a signed request must not be processed by a not-live leg.
      const res = await callPost(provider, '{"event":"x"}', { 'x-webhook-signature': 'sig' });
      expect(res.status).toBe(501);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe('provider_not_live');
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it('returns 501 for a live signal leg that is signed but not yet configured', async () => {
    // gmail with a signature header (no dev-unsigned shortcut) and no
    // GOOGLE_OAUTH_CLIENT_ID → not_configured → 501, never enqueued.
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', '');
    const res = await callPost('gmail', '{"emailAddress":"a@b.com"}', {
      'x-webhook-signature': 'sig',
    });
    expect(res.status).toBe(501);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 501 for stripe (billing contract) when STRIPE_WEBHOOK_SECRET is absent', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const res = await callPost('stripe', '{"type":"checkout.session.completed"}', {
      'stripe-signature': 'v1=sig',
    });
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('stripe_billing_not_live');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
