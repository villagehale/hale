import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import {
  STRIPE_LOOKUP_VERSION,
  StripeLookupError,
  stripeChargeLookupFromEnv,
} from './stripe-charge-context.js';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_fixture' };
const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const START = 1_767_225_600;
const END = 1_798_761_600;
const PRIOR_START = 1_735_689_600;

function lookupFor(fake: FakeStripe) {
  const lookup = stripeChargeLookupFromEnv(ENV, fake.fetch);
  if (!lookup) throw new Error('no lookup');
  return lookup;
}

function purchase(fake: FakeStripe, suffix = '1', customer = 'cus_1', familyId = FAMILY) {
  fake.addSubscription({
    id: `sub_${suffix}`,
    customer,
    familyId,
    created: START,
    periodStart: START,
    periodEnd: END,
  });
  fake.addPaidInvoice({
    subscriptionId: `sub_${suffix}`,
    invoiceId: `in_${suffix}`,
    chargeId: `ch_${suffix}`,
    paymentIntentId: `pi_${suffix}`,
    periodStart: START,
    periodEnd: END,
  });
}

function paymentCalls(fake: FakeStripe) {
  return fake.calls.filter((call) => call.path === '/v1/invoice_payments');
}

const SCAN_DEFAULTS = {
  familyId: FAMILY,
  excludeSubscriptionId: 'sub_1',
  customerIds: ['cus_1'],
  storedCustomerId: null,
  storedSubscriptionId: null,
};

describe('stripeChargeLookupFromEnv', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => {
      throw new Error('a test reached the global fetch');
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is absent without a secret', () => {
    expect(stripeChargeLookupFromEnv({})).toBeNull();
  });

  it('resolves a charge with no invoice key through its invoice payment', async () => {
    const fake = createFakeStripe();
    purchase(fake);
    expect(fake.charges.get('ch_1')).not.toHaveProperty('invoice');

    await expect(lookupFor(fake).lookupCharge('ch_1')).resolves.toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      subscriptionCreated: START,
      subscriptionCustomerId: 'cus_1',
      subscriptionFamilyId: FAMILY,
      familyId: FAMILY,
      periodStanding: 'current',
      invoiceCreated: START,
    });

    const [payments] = paymentCalls(fake);
    expect(payments?.query.get('payment[type]')).toBe('payment_intent');
    expect(payments?.query.get('payment[payment_intent]')).toBe('pi_1');
    expect(payments?.query.get('status')).toBe('paid');
  });

  it('pins every read to the documented API version', async () => {
    const fake = createFakeStripe();
    purchase(fake);
    await lookupFor(fake).lookupCharge('ch_1');
    expect(STRIPE_LOOKUP_VERSION).toBe('2026-11-18.endive');
    expect(fake.calls.length).toBe(4);
    for (const call of fake.calls) {
      expect(call.headers.get('stripe-version')).toBe('2026-11-18.endive');
    }
  });

  describe('periodStanding', () => {
    it('reads the previous period as older', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      fake.addPaidInvoice({
        subscriptionId: 'sub_1',
        invoiceId: 'in_prior',
        chargeId: 'ch_prior',
        paymentIntentId: 'pi_prior',
        periodStart: PRIOR_START,
        periodEnd: START,
        billingReason: 'subscription_cycle',
        latest: false,
      });
      const found = await lookupFor(fake).lookupCharge('ch_prior');
      expect(found.subscriptionId).toBe('sub_1');
      expect(found.periodStanding).toBe('older');
    });

    it('does not read a proration line as the current period', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      fake.addPaidInvoice({
        subscriptionId: 'sub_1',
        invoiceId: 'in_proration',
        chargeId: 'ch_proration',
        paymentIntentId: 'pi_proration',
        periodStart: START,
        periodEnd: END,
        billingReason: 'subscription_update',
        proration: true,
        latest: false,
      });
      const found = await lookupFor(fake).lookupCharge('ch_proration');
      expect(found.periodStanding).toBe('older');
    });

    it('calls a latest first-charge invoice whose period disagrees unproven', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      const subscription = fake.subscriptions.get('sub_1');
      const item = subscription?.items.data[0];
      if (!item) throw new Error('no item');
      item.current_period_end = END + 60;
      const found = await lookupFor(fake).lookupCharge('ch_1');
      expect(found.periodStanding).toBe('unproven');
    });
  });

  describe('a charge that is not tied to a subscription', () => {
    it('finds no subscription when no invoice payment exists', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      fake.invoicePayments.length = 0;
      const found = await lookupFor(fake).lookupCharge('ch_1');
      expect(found.subscriptionId).toBeNull();
      expect(paymentCalls(fake).length).toBe(1);
    });

    it('finds no subscription when the payment intent paid two invoices', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      const [first] = fake.invoicePayments;
      if (!first) throw new Error('no payment');
      fake.invoicePayments.push({ ...first, id: 'inpay_2', invoice: 'in_2' });
      const found = await lookupFor(fake).lookupCharge('ch_1');
      expect(found.subscriptionId).toBeNull();
      expect(paymentCalls(fake)[0]?.query.get('limit')).toBe('2');
    });

    it.each([
      ['a null parent', null],
      ['a quote parent', { type: 'quote_details', quote_details: { quote: 'qt_1' } }],
    ])('finds no subscription for an invoice with %s', async (_name, parent) => {
      const fake = createFakeStripe();
      purchase(fake);
      const invoice = fake.invoices.get('in_1');
      if (!invoice) throw new Error('no invoice');
      invoice.parent = parent;
      const found = await lookupFor(fake).lookupCharge('ch_1');
      expect(found.subscriptionId).toBeNull();
      expect(paymentCalls(fake).length).toBe(1);
    });

    it('stops at a charge with no payment intent', async () => {
      const fake = createFakeStripe();
      purchase(fake);
      const charge = fake.charges.get('ch_1');
      if (!charge) throw new Error('no charge');
      charge.payment_intent = null;
      const found = await lookupFor(fake).lookupCharge('ch_1');
      expect(found).toMatchObject({ subscriptionId: null, customerId: 'cus_1' });
      expect(paymentCalls(fake).length).toBe(0);
    });
  });

  describe('failure classes', () => {
    it.each([429, 500, 503])('reads a %i as transient', async (status) => {
      const fake = createFakeStripe();
      fake.intercept(
        () => true,
        () => stripeError(status),
      );
      await expect(lookupFor(fake).lookupCharge('ch_1')).rejects.toMatchObject({
        kind: 'transient',
        statusCode: status,
      });
    });

    it('reads a network failure as transient', async () => {
      const fake = createFakeStripe();
      fake.intercept(
        () => true,
        () => {
          throw new TypeError('fetch failed');
        },
      );
      const failure = await lookupFor(fake)
        .lookupCharge('ch_1')
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(StripeLookupError);
      expect(failure).toMatchObject({ kind: 'transient', statusCode: null });
    });

    it('reads a timeout as transient', async () => {
      const fake = createFakeStripe();
      fake.intercept(
        () => true,
        () => {
          throw new DOMException('The operation timed out', 'TimeoutError');
        },
      );
      await expect(lookupFor(fake).lookupCharge('ch_1')).rejects.toMatchObject({
        kind: 'transient',
        statusCode: null,
      });
    });

    it.each([400, 401, 403])('reads a %i as refused', async (status) => {
      const fake = createFakeStripe();
      fake.intercept(
        () => true,
        () => stripeError(status),
      );
      await expect(lookupFor(fake).lookupCharge('ch_1')).rejects.toMatchObject({
        kind: 'refused',
        statusCode: status,
      });
    });

    it('reads a 404 on the charge, its invoice payments and its subscription as refused', async () => {
      const onCharge = createFakeStripe();
      await expect(lookupFor(onCharge).lookupCharge('ch_gone')).rejects.toMatchObject({
        kind: 'refused',
        statusCode: 404,
      });

      const onPayments = createFakeStripe();
      purchase(onPayments);
      onPayments.intercept(
        (call) => call.path === '/v1/invoice_payments',
        () => stripeError(404),
      );
      await expect(lookupFor(onPayments).lookupCharge('ch_1')).rejects.toMatchObject({
        kind: 'refused',
        statusCode: 404,
      });

      const onSubscription = createFakeStripe();
      purchase(onSubscription);
      onSubscription.subscriptions.delete('sub_1');
      await expect(lookupFor(onSubscription).lookupCharge('ch_1')).rejects.toMatchObject({
        kind: 'refused',
        statusCode: 404,
      });
    });
  });

  describe('otherSubscriptions', () => {
    it('searches on the family id alone and finds a sibling on another customer', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
      const search = fake.calls.find((call) => call.path === '/v1/subscriptions/search');
      expect(search?.query.get('query')).toBe(`metadata["familyId"]:"${FAMILY}"`);
      expect(found).toEqual({
        paid: [{ id: 'sub_2', priceId: 'price_plus', status: 'active' }],
        refundedIds: [],
        truncated: false,
      });
    });

    it('excludes S, lists each customer once, and ignores another family', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '3', 'cus_1', OTHER_FAMILY);
      const found = await lookupFor(fake).otherSubscriptions({
        ...SCAN_DEFAULTS,
        customerIds: ['cus_1', 'cus_1'],
        storedCustomerId: 'cus_1',
      });
      expect(found).toEqual({ paid: [], refundedIds: [], truncated: false });
      const lists = fake.calls.filter((call) => call.path === '/v1/subscriptions');
      expect(lists.map((call) => call.query.get('customer'))).toEqual(['cus_1']);
    });

    it.each(['/v1/subscriptions', '/v1/subscriptions/search'])(
      'calls has_more on %s truncated',
      async (path) => {
        const fake = createFakeStripe();
        purchase(fake);
        fake.intercept(
          (call) => call.path === path,
          () => Response.json({ object: 'list', url: path, has_more: true, data: [] }),
        );
        const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
        expect(found.truncated).toBe(true);
      },
    );

    it('files a sibling whose current charge is fully refunded under refundedIds', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      fake.refund('ch_2');
      await expect(lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS)).resolves.toEqual({
        paid: [],
        refundedIds: ['sub_2'],
        truncated: false,
      });
    });

    it('counts a partly refunded sibling as paid', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      const charge = fake.charges.get('ch_2');
      if (!charge) throw new Error('no charge');
      charge.amount_refunded = 100;
      const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
      expect(found.paid.map((row) => row.id)).toEqual(['sub_2']);
      expect(found.refundedIds).toEqual([]);
    });

    it('counts a sibling whose latest invoice is from an older period as paid', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      fake.refund('ch_2');
      const item = fake.subscriptions.get('sub_2')?.items.data[0];
      if (!item) throw new Error('no item');
      item.current_period_start = END;
      item.current_period_end = END + 86_400;
      const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
      expect(found.paid.map((row) => row.id)).toEqual(['sub_2']);
    });

    it('counts a sibling with no latest invoice as paid', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      fake.refund('ch_2');
      const sibling = fake.subscriptions.get('sub_2');
      if (!sibling) throw new Error('no sibling');
      sibling.latest_invoice = null;
      const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
      expect(found.paid.map((row) => row.id)).toEqual(['sub_2']);
    });

    it('counts a sibling whose invoice has two payments as paid', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      purchase(fake, '2', 'cus_2');
      fake.refund('ch_2');
      const payment = fake.invoicePayments.find((row) => row.invoice === 'in_2');
      if (!payment) throw new Error('no payment');
      fake.invoicePayments.push({ ...payment, id: 'inpay_extra' });
      const found = await lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS);
      expect(found.paid.map((row) => row.id)).toEqual(['sub_2']);
    });

    it('treats the stored subscription as paid when live and as absent on a 404', async () => {
      const live = createFakeStripe();
      purchase(live, '1', 'cus_1');
      purchase(live, '4', 'cus_4', OTHER_FAMILY);
      const liveSub = live.subscriptions.get('sub_4');
      if (!liveSub) throw new Error('no sub');
      liveSub.metadata = {};
      await expect(
        lookupFor(live).otherSubscriptions({ ...SCAN_DEFAULTS, storedSubscriptionId: 'sub_4' }),
      ).resolves.toMatchObject({ paid: [{ id: 'sub_4' }] });

      const gone = createFakeStripe();
      purchase(gone, '1', 'cus_1');
      await expect(
        lookupFor(gone).otherSubscriptions({ ...SCAN_DEFAULTS, storedSubscriptionId: 'sub_gone' }),
      ).resolves.toEqual({ paid: [], refundedIds: [], truncated: false });
    });

    it('skips a stored customer that no longer exists', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      fake.intercept(
        (call) => call.path === '/v1/subscriptions' && call.query.get('customer') === 'cus_gone',
        () => stripeError(400, 'resource_missing'),
      );
      await expect(
        lookupFor(fake).otherSubscriptions({ ...SCAN_DEFAULTS, storedCustomerId: 'cus_gone' }),
      ).resolves.toEqual({ paid: [], refundedIds: [], truncated: false });
    });

    it('throws on a 500 from the stored customer or the stored subscription', async () => {
      const onCustomer = createFakeStripe();
      purchase(onCustomer, '1', 'cus_1');
      onCustomer.intercept(
        (call) => call.path === '/v1/subscriptions' && call.query.get('customer') === 'cus_9',
        () => stripeError(500),
      );
      await expect(
        lookupFor(onCustomer).otherSubscriptions({ ...SCAN_DEFAULTS, storedCustomerId: 'cus_9' }),
      ).rejects.toMatchObject({ kind: 'transient', statusCode: 500 });

      const onSubscription = createFakeStripe();
      purchase(onSubscription, '1', 'cus_1');
      onSubscription.intercept(
        (call) => call.path === '/v1/subscriptions/sub_9',
        () => stripeError(500),
      );
      await expect(
        lookupFor(onSubscription).otherSubscriptions({
          ...SCAN_DEFAULTS,
          storedSubscriptionId: 'sub_9',
        }),
      ).rejects.toMatchObject({ kind: 'transient', statusCode: 500 });
    });

    it('does not read a refusal on a stored id as "nothing there"', async () => {
      const onCustomer = createFakeStripe();
      purchase(onCustomer, '1', 'cus_1');
      onCustomer.intercept(
        (call) => call.path === '/v1/subscriptions' && call.query.get('customer') === 'cus_9',
        () => stripeError(403),
      );
      await expect(
        lookupFor(onCustomer).otherSubscriptions({ ...SCAN_DEFAULTS, storedCustomerId: 'cus_9' }),
      ).rejects.toMatchObject({ kind: 'refused', statusCode: 403 });

      const onSubscription = createFakeStripe();
      purchase(onSubscription, '1', 'cus_1');
      onSubscription.intercept(
        (call) => call.path === '/v1/subscriptions/sub_9',
        () => stripeError(403),
      );
      await expect(
        lookupFor(onSubscription).otherSubscriptions({
          ...SCAN_DEFAULTS,
          storedSubscriptionId: 'sub_9',
        }),
      ).rejects.toMatchObject({ kind: 'refused', statusCode: 403 });
    });

    it('does not skip a charge customer that refuses, only a stored one', async () => {
      const fake = createFakeStripe();
      purchase(fake, '1', 'cus_1');
      fake.intercept(
        (call) => call.path === '/v1/subscriptions' && call.query.get('customer') === 'cus_1',
        () => stripeError(400, 'resource_missing'),
      );
      await expect(lookupFor(fake).otherSubscriptions(SCAN_DEFAULTS)).rejects.toMatchObject({
        kind: 'refused',
        statusCode: 400,
      });
    });
  });

  it('reads a subscription status', async () => {
    const fake = createFakeStripe();
    purchase(fake);
    await expect(lookupFor(fake).subscriptionStatus('sub_1')).resolves.toBe('active');
  });
});
