import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads db + queue at request time. We stub those edges so the test
// exercises the route's dispatch (unknown→404, scaffold→501, live-unconfigured
// →501) and the never-ingest guarantee — not real infra. The per-provider logic
// is covered separately in registry.test. The Stripe apply is stubbed so the
// verified-path test asserts the route wires verify→apply, not the DB write
// (covered in stripe-billing-apply.test).
const sendMock = vi.fn();
const applyMock = vi.fn();
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: sendMock }) }));
vi.mock('~/lib/webhooks/stripe-billing-apply', () => ({
  applyStripeBillingEvent: (...args: unknown[]) => applyMock(...args),
}));

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
    applyMock.mockReset();
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

  // ── VIL-253 · forged requests reach nothing ────────────────────────────────
  // The bug this locks: gmail/gcal/outlook accepted ANY non-empty signature once
  // their OAuth client-id env var existed, and GOOGLE_OAUTH_CLIENT_ID IS set in
  // production — so this exact request used to enqueue an events.ingested job,
  // putting attacker text in front of the classifier and the family digest.
  // The assertion that matters is `sendMock` never being called.
  describe.each(['gmail', 'gcal', 'outlook'])('%s — credential present, forged request', (provider) => {
    beforeEach(() => {
      vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'provisioned-in-prod');
      vi.stubEnv('MICROSOFT_OAUTH_CLIENT_ID', 'provisioned-in-prod');
    });

    it.each([
      ['no signature header', {}],
      ['an empty signature', { 'x-webhook-signature': '' }],
      ['an arbitrary signature', { 'x-webhook-signature': 'anything-at-all' }],
      ['a bearer-token-shaped signature', { 'x-webhook-signature': 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x' }],
      ['a stripe-shaped signature', { 'x-webhook-signature': 'v1=deadbeef' }],
      ['a stripe-signature header instead', { 'stripe-signature': 'v1=deadbeef' }],
    ])('refuses %s with 501 and never enqueues', async (_name, headers) => {
      const res = await callPost(
        provider,
        '{"emailAddress":"parent@example.com","channelId":"chan_1","subscriptionId":"sub_1"}',
        headers as Record<string, string>,
      );

      expect(res.status).toBe(501);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'provider_not_live',
      });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('refuses a payload crafted to look like a real push notification', async () => {
      const res = await callPost(
        provider,
        JSON.stringify({
          message: { data: Buffer.from('{"emailAddress":"parent@example.com"}').toString('base64') },
          subscription: 'projects/hale/subscriptions/gmail-push',
        }),
        { 'x-webhook-signature': 'sig', authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x' },
      );

      expect(res.status).toBe(501);
      expect(sendMock).not.toHaveBeenCalled();
    });
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
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('applies a verified stripe billing event and returns its status (never enqueues)', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    applyMock.mockResolvedValue({ status: 'applied', tier: 'plus' });
    const body = '{"id":"evt_1","type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const hex = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');

    const res = await callPost('stripe', body, { 'stripe-signature': `t=${t},v1=${hex}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'applied' });
    expect(applyMock).toHaveBeenCalledWith({ id: 'evt_1', type: 'checkout.session.completed' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a stripe request with a bad signature as 401 (never applies)', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    const t = Math.floor(Date.now() / 1000);
    const res = await callPost('stripe', '{"id":"evt_1"}', {
      'stripe-signature': `t=${t},v1=${'0'.repeat(64)}`,
    });
    expect(res.status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
