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
const reportMock = vi.fn();
const unboundMock = vi.fn();
const recordNoticeMock = vi.fn();
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: sendMock }) }));
vi.mock('~/lib/webhooks/stripe-billing-apply', () => ({
  applyStripeBillingEvent: (...args: unknown[]) => applyMock(...args),
}));
vi.mock('~/lib/billing/conversions', () => ({
  reportBillingPurchase: (...args: unknown[]) => reportMock(...args),
  deliverUnboundCheckoutPurchase: (...args: unknown[]) => unboundMock(...args),
}));
vi.mock('~/lib/billing/notices/record', () => ({
  recordBillingNoticeIntent: (...args: unknown[]) => recordNoticeMock(...args),
}));

function signedStripeEvent(id: string): { body: string; signature: string } {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
  const body = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  return { body, signature: `t=${t},v1=${hex}` };
}

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
    reportMock.mockReset();
    reportMock.mockResolvedValue({ status: 'skipped', reason: 'not_a_purchase' });
    unboundMock.mockReset();
    unboundMock.mockResolvedValue({ status: 'skipped', reason: 'flag_off' });
    recordNoticeMock.mockReset();
    recordNoticeMock.mockResolvedValue('dark');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 404 for an unknown provider', { timeout: 15_000 }, async () => {
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

  it('VIL-401 flag off: a calendar push is still a no-op (501, nothing queued)', async () => {
    vi.stubEnv('GOOGLE_PUSH_SYNC_ENABLED', 'false');
    const res = await callPost('gcal', '{}', {
      'x-goog-channel-id': 'chan-1',
      'x-goog-channel-token': 'secret',
      'x-goog-resource-id': 'res-1',
    });
    expect(res.status).toBe(501);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('VIL-401 flag on: a calendar push missing channel headers is 401 and not ingested', async () => {
    vi.stubEnv('GOOGLE_PUSH_SYNC_ENABLED', 'true');
    const res = await callPost('gcal', '{}');
    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

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
  describe.each(['gmail', 'gcal', 'outlook'])(
    '%s — credential present, forged request',
    (provider) => {
      beforeEach(() => {
        vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'provisioned-in-prod');
        vi.stubEnv('MICROSOFT_OAUTH_CLIENT_ID', 'provisioned-in-prod');
      });

      it.each([
        ['no signature header', {}],
        ['an empty signature', { 'x-webhook-signature': '' }],
        ['an arbitrary signature', { 'x-webhook-signature': 'anything-at-all' }],
        [
          'a bearer-token-shaped signature',
          { 'x-webhook-signature': 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x' },
        ],
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
            message: {
              data: Buffer.from('{"emailAddress":"parent@example.com"}').toString('base64'),
            },
            subscription: 'projects/hale/subscriptions/gmail-push',
          }),
          { 'x-webhook-signature': 'sig', authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x' },
        );

        expect(res.status).toBe(501);
        expect(sendMock).not.toHaveBeenCalled();
      });
    },
  );

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
    expect(reportMock).toHaveBeenCalledWith({ id: 'evt_1', type: 'checkout.session.completed' });
    expect(unboundMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reports an unbound checkout on the session person, not as a family purchase', async () => {
    const { body, signature } = signedStripeEvent('evt_unbound_1');
    applyMock.mockResolvedValue({ status: 'unbound' });

    const res = await callPost('stripe', body, { 'stripe-signature': signature });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unbound' });
    expect(reportMock).not.toHaveBeenCalled();
    expect(unboundMock).toHaveBeenCalledTimes(1);
    expect(unboundMock.mock.calls[0]?.[1]).toEqual(JSON.parse(body));
  });

  it('answers 503 on retry so Stripe redelivers, and reports no conversion', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    applyMock.mockResolvedValue({ status: 'retry', reason: 'stripe_unavailable' });
    const body = '{"id":"evt_1","type":"charge.refunded"}';
    const t = Math.floor(Date.now() / 1000);
    const hex = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');

    const res = await callPost('stripe', body, { 'stripe-signature': `t=${t},v1=${hex}` });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'retry', reason: 'stripe_unavailable' });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('does not send conversions when a paid session is refund-ready', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    applyMock.mockResolvedValue({ status: 'refund_ready' });
    const body = '{"id":"evt_1","type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const hex = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');

    const res = await callPost('stripe', body, { 'stripe-signature': `t=${t},v1=${hex}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'refund_ready' });
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('does not re-send conversions on a duplicate Stripe event', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    applyMock.mockResolvedValue({ status: 'duplicate' });
    const body = '{"id":"evt_1","type":"checkout.session.completed"}';
    const t = Math.floor(Date.now() / 1000);
    const hex = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');

    const res = await callPost('stripe', body, { 'stripe-signature': `t=${t},v1=${hex}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'duplicate' });
    expect(reportMock).not.toHaveBeenCalled();
    expect(unboundMock).not.toHaveBeenCalled();
  });

  it('VIL-735 records the notice intent after apply and conversions, with the apply result', async () => {
    const { body, signature } = signedStripeEvent('evt_notice_1');
    applyMock.mockResolvedValue({ status: 'applied', tier: 'plus' });
    const order: string[] = [];
    reportMock.mockImplementation(async () => {
      order.push('conversions');
      return { status: 'skipped', reason: 'not_a_purchase' };
    });
    recordNoticeMock.mockImplementation(async () => {
      order.push('notice');
      return 'recorded';
    });

    const res = await callPost('stripe', body, { 'stripe-signature': signature });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'applied' });
    expect(order).toEqual(['conversions', 'notice']);
    expect(recordNoticeMock).toHaveBeenCalledTimes(1);
    expect(recordNoticeMock.mock.calls[0]?.[1]).toEqual(JSON.parse(body));
    expect(recordNoticeMock.mock.calls[0]?.[2]).toEqual({ status: 'applied', tier: 'plus' });
  });

  it('VIL-735 a thrown notice write stays a 500, and the redelivery records without reporting twice', async () => {
    const { body, signature } = signedStripeEvent('evt_notice_2');
    applyMock.mockResolvedValueOnce({ status: 'applied', tier: 'plus' });
    recordNoticeMock.mockRejectedValueOnce(new Error('db down'));
    await expect(callPost('stripe', body, { 'stripe-signature': signature })).rejects.toThrow(
      'db down',
    );
    expect(reportMock).toHaveBeenCalledTimes(1);

    applyMock.mockResolvedValueOnce({ status: 'duplicate' });
    recordNoticeMock.mockResolvedValueOnce('recorded');
    const retried = await callPost('stripe', body, { 'stripe-signature': signature });

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ status: 'duplicate' });
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(recordNoticeMock).toHaveBeenCalledTimes(2);
    expect(recordNoticeMock.mock.calls[1]?.[2]).toEqual({ status: 'duplicate' });
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
