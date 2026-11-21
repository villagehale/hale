import { LIVE_SUBSCRIPTION } from '~/lib/webhooks/stripe-billing';

/**
 * Stripe charge → customer, subscription, and family.
 *
 * A charge.refunded or dispute payload names a charge, not a subscription. Since
 * 2025-03-31.basil a Charge has no `invoice`, so the link runs through the invoice
 * payment for its PaymentIntent, which is Stripe's documented procedure for this case
 * (docs.stripe.com/billing/subscriptions/webhooks#refund-events).
 */

/** Every read is pinned, so a Workbench upgrade cannot change these shapes under the code. */
export const STRIPE_LOOKUP_VERSION = '2026-11-18.endive';
export const STRIPE_LOOKUP_TIMEOUT_MS = 5_000;
const STRIPE_LIST_LIMIT = '100';

/**
 * `transient`: a timeout, a network error, a 429 or a 5xx. `refused`: any other non-2xx,
 * including a 404 on an object Stripe itself just named, which means a wrong key, mode or
 * route. Neither is an answer about the subscription, so neither may be claimed.
 */
export class StripeLookupError extends Error {
  readonly kind: 'transient' | 'refused';
  readonly statusCode: number | null;
  readonly code: string | null;

  constructor(
    kind: 'transient' | 'refused',
    statusCode: number | null,
    code: string | null = null,
  ) {
    super(`stripe lookup ${kind}: ${statusCode ?? 'network'}`);
    this.name = 'StripeLookupError';
    this.kind = kind;
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * `current`: a non-proration line for S matches the item's current period.
 * `unproven`: no line matches, yet this is S's latest invoice for a create or a cycle,
 * so one should have. `older`: anything else.
 */
export type PeriodStanding = 'current' | 'older' | 'unproven';

export interface StripeChargeContext {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** Unix seconds. */
  subscriptionCreated: number | null;
  subscriptionCustomerId: string | null;
  subscriptionFamilyId: string | null;
  familyId: string | null;
  /** Null when no subscription resolved. */
  periodStanding: PeriodStanding | null;
}

export interface OtherSubscriptions {
  /** Live subscriptions whose current period is not proven refunded. */
  paid: ReadonlyArray<{ id: string; priceId: string | null }>;
  /** Live subscriptions whose current-period charge is proven fully refunded. */
  refundedIds: readonly string[];
  /** A list or search had more than a page, so "nothing else" cannot be concluded. */
  truncated: boolean;
}

export interface StripeChargeLookup {
  lookupCharge(chargeId: string): Promise<StripeChargeContext>;
  subscriptionStatus(subscriptionId: string): Promise<string>;
  otherSubscriptions(input: {
    familyId: string;
    excludeSubscriptionId: string | null;
    customerIds: readonly string[];
    storedCustomerId: string | null;
    storedSubscriptionId: string | null;
  }): Promise<OtherSubscriptions>;
}

type StripeObject = Record<string, unknown>;
type StripeRead = (path: string) => Promise<StripeObject>;

export function stripeChargeLookupFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripeChargeLookup | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return null;
  const get: StripeRead = (path) => stripeGet(secret, path, fetchImpl);
  return {
    lookupCharge: (chargeId) => lookupCharge(get, chargeId),
    async subscriptionStatus(subscriptionId) {
      const subscription = await get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
      const status = readString(subscription.status)?.toLowerCase();
      if (!status) throw new StripeLookupError('refused', null);
      return status;
    },
    otherSubscriptions: (input) => otherSubscriptions(get, input),
  };
}

async function lookupCharge(get: StripeRead, chargeId: string): Promise<StripeChargeContext> {
  const charge = await get(`/v1/charges/${encodeURIComponent(chargeId)}`);
  const customerId = readId(charge.customer);
  const chargeFamily = familyFromMetadata(charge);
  const notTied = (family: string | null, customer: string | null): StripeChargeContext => ({
    customerId: customer,
    subscriptionId: null,
    subscriptionStatus: null,
    subscriptionCreated: null,
    subscriptionCustomerId: null,
    subscriptionFamilyId: null,
    familyId: family,
    periodStanding: null,
  });

  const paymentIntentId = readId(charge.payment_intent);
  if (!paymentIntentId) return notTied(chargeFamily, customerId);

  const payments = await paidInvoicePayments(get, {
    'payment[type]': 'payment_intent',
    'payment[payment_intent]': paymentIntentId,
  });
  const invoiceId = payments.length === 1 ? readId(payments[0]?.invoice) : null;
  if (!invoiceId) return notTied(chargeFamily, customerId);

  const invoice = await get(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
  const family =
    chargeFamily ?? familyFromMetadata(invoice) ?? familyFromSubscriptionDetails(invoice);
  const invoiceCustomer = customerId ?? readId(invoice.customer);
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return notTied(family, invoiceCustomer);

  const subscription = await get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const subscriptionFamilyId = familyFromMetadata(subscription);
  return {
    customerId: invoiceCustomer,
    subscriptionId,
    subscriptionStatus: readString(subscription.status)?.toLowerCase() ?? null,
    subscriptionCreated: typeof subscription.created === 'number' ? subscription.created : null,
    subscriptionCustomerId: readId(subscription.customer),
    subscriptionFamilyId,
    familyId: family ?? subscriptionFamilyId,
    periodStanding: periodStanding(invoice, subscription, subscriptionId),
  };
}

/** Two results is already ambiguous, so a second page is never needed. */
async function paidInvoicePayments(
  get: StripeRead,
  filter: Record<string, string>,
): Promise<StripeObject[]> {
  const query = new URLSearchParams({ ...filter, status: 'paid', limit: '2' });
  return listData(await get(`/v1/invoice_payments?${query}`));
}

async function otherSubscriptions(
  get: StripeRead,
  input: Parameters<StripeChargeLookup['otherSubscriptions']>[0],
): Promise<OtherSubscriptions> {
  const { familyId, excludeSubscriptionId, storedCustomerId, storedSubscriptionId } = input;
  const found = new Map<string, StripeObject>();
  let truncated = false;
  const collect = (page: StripeObject) => {
    if (page.has_more === true) truncated = true;
    for (const subscription of listData(page)) {
      const id = readId(subscription.id);
      if (id) found.set(id, subscription);
    }
  };

  const customers = new Set(input.customerIds);
  if (storedCustomerId) customers.add(storedCustomerId);
  for (const customer of customers) {
    const query = new URLSearchParams({ customer, limit: STRIPE_LIST_LIMIT });
    try {
      collect(await get(`/v1/subscriptions?${query}`));
    } catch (err) {
      if (customer !== storedCustomerId || !isNotFound(err)) throw err;
    }
  }

  // A duplicate checkout usually sits on a second Customer, so only the family's own
  // metadata can find it. No `status` clause: search filters on a cached status.
  const search = new URLSearchParams({
    query: `metadata["familyId"]:"${familyId}"`,
    limit: STRIPE_LIST_LIMIT,
  });
  collect(await get(`/v1/subscriptions/search?${search}`));

  if (
    storedSubscriptionId &&
    storedSubscriptionId !== excludeSubscriptionId &&
    !found.has(storedSubscriptionId)
  ) {
    try {
      const stored = await get(`/v1/subscriptions/${encodeURIComponent(storedSubscriptionId)}`);
      found.set(storedSubscriptionId, stored);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  const paid: Array<{ id: string; priceId: string | null }> = [];
  const refundedIds: string[] = [];
  for (const [id, subscription] of found) {
    if (id === excludeSubscriptionId) continue;
    const metadataFamily = familyFromMetadata(subscription);
    if (metadataFamily !== null && metadataFamily !== familyId) continue;
    const status = readString(subscription.status)?.toLowerCase();
    if (!status || !LIVE_SUBSCRIPTION.has(status)) continue;
    if (await currentPeriodRefunded(get, id, subscription)) {
      refundedIds.push(id);
    } else {
      paid.push({ id, priceId: subscriptionPriceId(subscription) });
    }
  }
  return { paid, refundedIds, truncated };
}

/** Refunded only on proof. Anything less counts as paid, so every doubt keeps the plan. */
async function currentPeriodRefunded(
  get: StripeRead,
  subscriptionId: string,
  subscription: StripeObject,
): Promise<boolean> {
  const invoiceId = readId(subscription.latest_invoice);
  if (!invoiceId) return false;
  const invoice = await get(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
  if (periodStanding(invoice, subscription, subscriptionId) !== 'current') return false;
  const payments = await paidInvoicePayments(get, { invoice: invoiceId });
  const payment =
    payments.length === 1 && isRecord(payments[0]?.payment) ? payments[0].payment : null;
  if (payment?.type !== 'payment_intent') return false;
  const paymentIntentId = readId(payment.payment_intent);
  if (!paymentIntentId) return false;
  const query = new URLSearchParams({ 'expand[]': 'latest_charge' });
  const intent = await get(`/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?${query}`);
  return isRecord(intent.latest_charge) && intent.latest_charge.refunded === true;
}

function periodStanding(
  invoice: StripeObject,
  subscription: StripeObject,
  subscriptionId: string,
): PeriodStanding {
  const items = isRecord(subscription.items) ? listData(subscription.items) : [];
  const lines = isRecord(invoice.lines) ? listData(invoice.lines) : [];
  if (lines.some((line) => lineIsCurrentPeriod(line, items, subscriptionId))) return 'current';
  const billingReason = readString(invoice.billing_reason);
  const shouldHaveMatched =
    readId(subscription.latest_invoice) === readId(invoice.id) &&
    (billingReason === 'subscription_create' || billingReason === 'subscription_cycle');
  return shouldHaveMatched ? 'unproven' : 'older';
}

function lineIsCurrentPeriod(
  line: StripeObject,
  items: readonly StripeObject[],
  subscriptionId: string,
): boolean {
  const parent = isRecord(line.parent) ? line.parent : null;
  const details =
    parent && isRecord(parent.subscription_item_details) ? parent.subscription_item_details : null;
  if (!details || details.proration !== false) return false;
  if (readId(details.subscription) !== subscriptionId) return false;
  const itemId = readId(details.subscription_item);
  const item = items.find((candidate) => readId(candidate.id) === itemId);
  const period = isRecord(line.period) ? line.period : null;
  if (!item || !period) return false;
  return (
    typeof period.start === 'number' &&
    period.start === item.current_period_start &&
    period.end === item.current_period_end
  );
}

async function stripeGet(
  secret: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.stripe.com${path}`, {
      headers: {
        authorization: `Bearer ${secret}`,
        'stripe-version': STRIPE_LOOKUP_VERSION,
      },
      signal: AbortSignal.timeout(STRIPE_LOOKUP_TIMEOUT_MS),
    });
  } catch {
    throw new StripeLookupError('transient', null);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new StripeLookupError('transient', res.status);
  }
  if (!res.ok) throw new StripeLookupError('refused', res.status, await stripeErrorCode(res));
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new StripeLookupError('transient', res.status);
  }
  if (!isRecord(json)) throw new StripeLookupError('transient', res.status);
  return json;
}

async function stripeErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as unknown;
    return isRecord(body) && isRecord(body.error) ? readString(body.error.code) : null;
  } catch {
    return null;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof StripeLookupError &&
    err.kind === 'refused' &&
    (err.statusCode === 404 || err.code === 'resource_missing')
  );
}

function listData(value: StripeObject): StripeObject[] {
  return Array.isArray(value.data) ? value.data.filter(isRecord) : [];
}

function subscriptionIdFromInvoice(invoice: StripeObject): string | null {
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  if (parent?.type !== 'subscription_details' || !isRecord(parent.subscription_details)) {
    return null;
  }
  return readId(parent.subscription_details.subscription);
}

function subscriptionPriceId(subscription: StripeObject): string | null {
  const items = isRecord(subscription.items) ? listData(subscription.items) : [];
  const price = items[0]?.price;
  return isRecord(price) ? readString(price.id) : null;
}

function familyFromSubscriptionDetails(invoice: StripeObject): string | null {
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  const details =
    parent && isRecord(parent.subscription_details) ? parent.subscription_details : null;
  return details ? familyFromMetadata(details) : null;
}

function familyFromMetadata(value: StripeObject): string | null {
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  return metadata ? readString(metadata.familyId) : null;
}

function readId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) return readString(value.id);
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
