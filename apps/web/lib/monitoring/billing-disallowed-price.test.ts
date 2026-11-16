import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  alertDisallowedCheckoutPrice,
  composeDisallowedPriceAlert,
} from './billing-disallowed-price';

describe('composeDisallowedPriceAlert', () => {
  it('names event, session, price ids and the refund-ready instruction, with no PII', () => {
    const text = composeDisallowedPriceAlert({
      eventId: 'evt_1',
      sessionId: 'cs_1',
      priceIds: ['price_cad_mo'],
      reason: 'list_price',
    });
    expect(text).toContain('event=evt_1');
    expect(text).toContain('session=cs_1');
    expect(text).toContain('prices=price_cad_mo');
    expect(text).toContain('reason=list_price');
    expect(text).toContain('refund-ready');
    expect(text).toContain('do not auto-refund');
    expect(text).not.toMatch(/fam-|@|phone|email/i);
  });
});

describe('alertDisallowedCheckoutPrice', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('posts the alert to #ops when the webhook is configured', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const outcome = await alertDisallowedCheckoutPrice(
      {
        eventId: 'evt_1',
        sessionId: 'cs_1',
        priceIds: ['price_cad_mo'],
        reason: 'list_price',
      },
      fetchImpl,
    );
    expect(outcome).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toContain('price_cad_mo');
    expect(body.text).not.toMatch(/fam-/);
  });

  it('names skipped_not_configured when OPS_SLACK_WEBHOOK_URL is absent', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');
    const fetchImpl = vi.fn();
    await expect(
      alertDisallowedCheckoutPrice(
        {
          eventId: 'evt_1',
          sessionId: 'cs_1',
          priceIds: ['price_cad_mo'],
          reason: 'list_price',
        },
        fetchImpl,
      ),
    ).resolves.toBe('skipped_not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
