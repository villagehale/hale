import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeFunnelSender } from '~/lib/analytics/funnel.testkit';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { deliverUnboundCheckoutPurchase } from './conversions';

const META = {
  META_CAPI_ENABLED: 'true',
  NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
  META_CAPI_ACCESS_TOKEN: 'token',
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function unboundEvent(sessionId: string, eventId: string) {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        amount_total: 5900,
        currency: 'cad',
        customer_details: { email: 'parent@example.com', phone: '+1 555 010 0199' },
        metadata: {
          source: 'pricing_direct',
          tier: 'plus',
          sku: 'promo_plus_annual',
          utm_source: 'google',
          msclkid: 'msclk',
          source_code: 'poster-oakville',
          fbp: 'fb.1.1.cookie',
          fbc: 'fb.1.1.click',
        } as Record<string, string>,
      },
    },
  };
}

describe('deliverUnboundCheckoutPurchase', () => {
  it('sends purchase and checkout_completed once, and Meta uses the session id', async () => {
    const seen: Array<{ event: string; distinctId: string; properties: Record<string, unknown> }> =
      [];
    const capture = async (
      event: 'purchase',
      distinctId: string,
      properties: Record<string, unknown>,
    ) => {
      seen.push({ event, distinctId, properties });
      return 'sent' as const;
    };
    const funnel = createFakeFunnelSender();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    });
    const env = { FUNNEL_ATTRIBUTION_ENABLED: 'true', ...META };
    const payload = unboundEvent('cs_test_unbound_1', 'evt_unbound_1');

    const first = await deliverUnboundCheckoutPurchase(
      db.database,
      payload,
      env,
      fetchImpl,
      funnel.sender,
      capture,
    );
    const second = await deliverUnboundCheckoutPurchase(
      db.database,
      payload,
      env,
      fetchImpl,
      funnel.sender,
      capture,
    );
    const otherEvent = await deliverUnboundCheckoutPurchase(
      db.database,
      unboundEvent('cs_test_unbound_1', 'evt_unbound_1b'),
      env,
      fetchImpl,
      funnel.sender,
      capture,
    );

    expect(first).toMatchObject({
      meta: { status: 'sent' },
      posthog: { status: 'sent' },
      funnel: 'sent',
    });
    expect(second).toEqual({ status: 'skipped', reason: 'duplicate' });
    expect(otherEvent).toEqual({ status: 'skipped', reason: 'duplicate' });
    expect(seen).toEqual([
      {
        event: 'purchase',
        distinctId: 'cs:cs_test_unbound_1',
        properties: {
          currency: 'CAD',
          value: 59,
          utm_source: 'google',
          msclkid: 'msclk',
          source_code: 'poster-oakville',
          sku: 'promo_plus_annual',
          tier: 'plus',
        },
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('parent@example.com');
    expect(JSON.stringify(seen)).not.toContain('555');
    expect(funnel.sent).toHaveLength(1);
    expect(funnel.sent[0]).toMatchObject({
      event: 'checkout_completed',
      distinctId: 'cs:cs_test_unbound_1',
      properties: {
        sku: 'promo_plus_annual',
        value: 59,
        currency: 'CAD',
        tier: 'plus',
        msclkid: 'msclk',
        source_code: 'poster-oakville',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      data: Array<{ event_id?: string; user_data?: Record<string, unknown> }>;
    };
    expect(body.data[0]?.event_id).toBe('cs_test_unbound_1');
    expect(body.data[0]?.user_data).toMatchObject({
      fbp: 'fb.1.1.cookie',
      fbc: 'fb.1.1.click',
    });
    expect(JSON.stringify(body)).not.toContain('parent@example.com');
    expect(JSON.stringify(body)).not.toContain('+1 555 010 0199');

    const claims = await db.database
      .select({ eventId: schema.stripeBillingEvents.eventId })
      .from(schema.stripeBillingEvents)
      .where(eq(schema.stripeBillingEvents.eventId, 'purchase:cs_test_unbound_1'));
    expect(claims).toHaveLength(1);
  });

  it('does not claim or send while the funnel flag is off, even when Meta is on', async () => {
    const seen: unknown[] = [];
    const capture = async () => {
      seen.push('sent');
      return 'sent' as const;
    };
    const funnel = createFakeFunnelSender();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 }),
    );
    const payload = unboundEvent('cs_test_unbound_dark', 'evt_unbound_dark');
    const dark = await deliverUnboundCheckoutPurchase(
      db.database,
      payload,
      META,
      fetchImpl,
      funnel.sender,
      capture,
    );
    expect(dark).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(seen).toEqual([]);
    expect(funnel.sent).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const lit = await deliverUnboundCheckoutPurchase(
      db.database,
      payload,
      { FUNNEL_ATTRIBUTION_ENABLED: 'true', ...META },
      fetchImpl,
      funnel.sender,
      capture,
    );
    expect(lit).toMatchObject({ meta: { status: 'sent' }, posthog: { status: 'sent' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not treat a family checkout as an unbound purchase', async () => {
    const capture = vi.fn(async () => 'sent' as const);
    const funnel = createFakeFunnelSender();
    const payload = unboundEvent('cs_test_unbound_family', 'evt_unbound_family');
    payload.data.object.metadata = {
      ...payload.data.object.metadata,
      familyId: 'fam-1',
    };
    const result = await deliverUnboundCheckoutPurchase(
      db.database,
      payload,
      { FUNNEL_ATTRIBUTION_ENABLED: 'true', ...META },
      vi.fn(),
      funnel.sender,
      capture,
    );
    expect(result).toEqual({ status: 'skipped', reason: 'not_a_purchase' });
    expect(capture).not.toHaveBeenCalled();
    expect(funnel.sent).toEqual([]);
  });
});
