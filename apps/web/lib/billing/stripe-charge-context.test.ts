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

  it('resolves a charge whose invoice is null through the payment intent', async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect(new Headers(init?.headers).get('stripe-version')).toBe('2026-11-18.endive');
      if (url.includes('/v1/charges/ch_live')) {
        return Response.json({
          id: 'ch_live',
          customer: 'cus_1',
          invoice: null,
          payment_intent: 'pi_1',
          metadata: { familyId: 'fam_1' },
        });
      }
      if (url.includes('/v1/invoice_payments?')) {
        return Response.json({ data: [{ invoice: 'in_live' }], has_more: false });
      }
      if (url.endsWith('/v1/invoices/in_live')) {
        return Response.json({
          id: 'in_live',
          customer: 'cus_1',
          parent: {
            type: 'subscription_details',
            subscription_details: {
              subscription: 'sub_live',
              metadata: { familyId: 'fam_1' },
            },
          },
        });
      }
      if (url.endsWith('/v1/subscriptions/sub_live')) {
        return Response.json({ id: 'sub_live', status: 'active', metadata: { familyId: 'fam_1' } });
      }
      return new Response('no', { status: 404 });
    };
    const lookup = stripeChargeLookupFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchImpl);
    await expect(lookup?.lookupCharge('ch_live')).resolves.toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_live',
      subscriptionStatus: 'active',
      familyId: 'fam_1',
    });
    expect(urls.some((url) => url.includes('payment%5Bpayment_intent%5D=pi_1'))).toBe(true);
  });

  it('leaves the subscription unknown when the payment intent matches two invoices', async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/v1/charges/ch_two')) {
        return Response.json({
          id: 'ch_two',
          customer: 'cus_1',
          invoice: null,
          payment_intent: 'pi_two',
          metadata: {},
        });
      }
      if (url.includes('/v1/invoice_payments?')) {
        return Response.json({
          data: [{ invoice: 'in_a' }, { invoice: 'in_b' }],
          has_more: false,
        });
      }
      return new Response('no', { status: 404 });
    };
    const lookup = stripeChargeLookupFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchImpl);
    await expect(lookup?.lookupCharge('ch_two')).resolves.toEqual({
      customerId: 'cus_1',
      subscriptionId: null,
      subscriptionStatus: null,
      familyId: null,
    });
    expect(urls.some((url) => url.includes('/v1/subscriptions/'))).toBe(false);
  });
});
