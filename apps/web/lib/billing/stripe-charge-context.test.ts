import { describe, expect, it } from 'vitest';
import { stripeChargeLookupFromEnv } from './stripe-charge-context.js';

describe('stripeChargeLookupFromEnv', () => {
  it('is absent without a secret and reads the invoice subscription when set', async () => {
    expect(stripeChargeLookupFromEnv({})).toBeNull();
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/charges/ch_1')) {
        return Response.json({ id: 'ch_1', customer: 'cus_1', invoice: 'in_1', metadata: {} });
      }
      if (url.endsWith('/v1/invoices/in_1')) {
        return Response.json({
          id: 'in_1',
          customer: 'cus_1',
          parent: {
            subscription_details: { subscription: 'sub_1', metadata: { familyId: 'fam_1' } },
          },
        });
      }
      if (url.endsWith('/v1/subscriptions/sub_1')) {
        return Response.json({ id: 'sub_1', status: 'canceled', metadata: { familyId: 'fam_1' } });
      }
      return new Response('no', { status: 404 });
    };
    const lookup = stripeChargeLookupFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchImpl);
    expect(lookup).not.toBeNull();
    await expect(lookup?.lookupCharge('ch_1')).resolves.toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      subscriptionStatus: 'canceled',
      familyId: 'fam_1',
    });
  });
});
