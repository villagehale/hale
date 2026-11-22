/**
 * Stripe charge → customer, subscription, and family.
 *
 * A charge.refunded payload carries an invoice id. A dispute payload carries a
 * charge id. Neither includes the subscription object unless Stripe expanded it,
 * so the webhook looks the charge up before it decides whether to drop a tier.
 */

import { ENDED_SUBSCRIPTION, type SubscriptionFacts } from '~/lib/webhooks/stripe-billing';

export interface StripeChargeContext {
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  familyId: string | null;
}

export interface StripeChargeLookup {
  lookupCharge(chargeId: string): Promise<StripeChargeContext>;
}

export function stripeChargeLookupFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripeChargeLookup | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return null;
  return {
    async lookupCharge(chargeId) {
      const charge = await stripeGet(
        secret,
        `/v1/charges/${encodeURIComponent(chargeId)}`,
        fetchImpl,
      );
      const invoiceId = readId(charge.invoice);
      const invoice = invoiceId
        ? await stripeGet(secret, `/v1/invoices/${encodeURIComponent(invoiceId)}`, fetchImpl)
        : null;
      const subscriptionId = invoice ? subscriptionIdFromInvoice(invoice) : null;
      const subscription = subscriptionId
        ? await stripeGet(
            secret,
            `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
            fetchImpl,
          )
        : null;
      const status = readString(subscription?.status)?.toLowerCase() ?? null;
      return {
        customerId: readId(charge.customer) ?? (invoice ? readId(invoice.customer) : null),
        subscriptionId,
        subscriptionStatus: status,
        familyId:
          familyFromMetadata(charge) ??
          (invoice ? familyFromMetadata(invoice) : null) ??
          (invoice ? familyFromSubscriptionDetails(invoice) : null) ??
          (subscription ? familyFromMetadata(subscription) : null),
      };
    },
  };
}

async function stripeGet(
  secret: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`https://api.stripe.com${path}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`stripe lookup failed: ${res.status}`);
  const json = (await res.json()) as unknown;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('stripe lookup returned a non-object');
  }
  return json as Record<string, unknown>;
}

function subscriptionIdFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = readId(invoice.subscription);
  if (direct) return direct;
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  const details =
    parent && isRecord(parent.subscription_details) ? parent.subscription_details : null;
  return details ? readId(details.subscription) : null;
}

function familyFromSubscriptionDetails(invoice: Record<string, unknown>): string | null {
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  const details =
    parent && isRecord(parent.subscription_details) ? parent.subscription_details : null;
  return details ? familyFromMetadata(details) : null;
}

function familyFromMetadata(value: Record<string, unknown>): string | null {
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

/** Every read below is pinned, so a Workbench upgrade cannot change these shapes under the code. */
export const STRIPE_LOOKUP_VERSION = '2026-11-18.endive';
export const STRIPE_LOOKUP_TIMEOUT_MS = 5_000;
const STRIPE_LIST_LIMIT = '100';
const PERIOD_INVOICE_LIMIT = '10';

/**
 * `transient`: a timeout, a network error, a 429 or a 5xx. `refused`: any other non-2xx,
 * including a 404 on an object Stripe itself just named, which means a wrong key, mode or
 * route. Neither is an answer about the subscription, so neither may be claimed.
 */
export class StripeLookupError extends Error {
  readonly kind: 'transient' | 'refused';
  readonly statusCode: number | null;
  readonly code: string | null;
  readonly call: 'lookup' | 'cancel';

  constructor(
    kind: 'transient' | 'refused',
    statusCode: number | null,
    code: string | null = null,
    call: 'lookup' | 'cancel' = 'lookup',
  ) {
    super(`stripe ${call} ${kind}: ${statusCode ?? 'network'}`);
    this.name = 'StripeLookupError';
    this.kind = kind;
    this.statusCode = statusCode;
    this.code = code;
    this.call = call;
  }
}

export interface StripeInvoiceFacts {
  id: string;
  billingReason: string | null;
  lines: ReadonlyArray<{
    subscriptionId: string | null;
    itemId: string | null;
    periodEnd: number | null;
  }>;
}

export interface RefundedCharge {
  chargeId: string;
  amountCaptured: number;
  customerId: string | null;
  familyId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  invoice: StripeInvoiceFacts | null;
}

export interface StripeSubscriptionRead extends SubscriptionFacts {
  customerId: string;
  latestInvoiceId: string | null;
  items: ReadonlyArray<{ id: string; currentPeriodEnd: number | null }>;
  periodInvoices: Array<{ id: string; refunded: boolean }>;
}

export type RefundPendingReason =
  | 'processing'
  | 'charge_pending'
  | 'insufficient_funds'
  | 'requires_action'
  | 'unknown';

export type RefundState =
  | { state: 'settled' }
  | { state: 'pending'; reason: RefundPendingReason }
  | { state: 'not_settled' };

export type InvoicePeriodFit = 'covers' | 'item_replaced' | 'older';

/** The refund path's view of Stripe. Reads are read-after-write except search. */
export interface StripePlanReader {
  refundedCharge(chargeId: string): Promise<RefundedCharge>;
  familySubscriptions(input: {
    familyId: string;
    /** Named by the event, so a 404 is a refusal. */
    eventCustomerId: string | null;
    eventSubscriptionId: string | null;
    /** From our own rows, so a 404 only means Stripe no longer has it. */
    rememberedCustomerIds: readonly string[];
    rememberedSubscriptionIds: readonly string[];
  }): Promise<{ subscriptions: StripeSubscriptionRead[]; truncated: boolean }>;
  refundState(chargeId: string, amountCaptured: number): Promise<RefundState>;
  otherOpenInvoices(customerId: string, subscriptionId: string): Promise<boolean>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

type StripeObject = Record<string, unknown>;
type StripeRead = (path: string) => Promise<StripeObject>;

export function stripePlanReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripePlanReader | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return null;
  const get: StripeRead = (path) => pinnedGet(secret, path, fetchImpl);
  return {
    refundedCharge: (chargeId) => refundedCharge(get, chargeId),
    familySubscriptions: (input) => familySubscriptions(get, input),
    async refundState(chargeId, amountCaptured) {
      const query = new URLSearchParams({ charge: chargeId, limit: STRIPE_LIST_LIMIT });
      return refundStateOf(await get(`/v1/refunds?${query}`), amountCaptured);
    },
    async otherOpenInvoices(customerId, subscriptionId) {
      const query = new URLSearchParams({
        customer: customerId,
        status: 'open',
        limit: STRIPE_LIST_LIMIT,
      });
      const page = await get(`/v1/invoices?${query}`);
      if (page.has_more === true) return true;
      return listData(page).some((row) => subscriptionIdOnInvoice(row) !== subscriptionId);
    },
    cancelSubscription: (subscriptionId) =>
      cancelSubscription(secret, subscriptionId, get, fetchImpl),
  };
}

async function refundedCharge(get: StripeRead, chargeId: string): Promise<RefundedCharge> {
  const charge = await get(`/v1/charges/${encodeURIComponent(chargeId)}`);
  if (typeof charge.amount_captured !== 'number') throw new StripeLookupError('refused', null);
  const base: RefundedCharge = {
    chargeId,
    amountCaptured: charge.amount_captured,
    customerId: readId(charge.customer),
    familyId: familyFromMetadata(charge),
    subscriptionId: null,
    subscriptionStatus: null,
    invoice: null,
  };
  const paymentIntentId = readId(charge.payment_intent);
  if (!paymentIntentId) return base;

  const query = new URLSearchParams({
    'payment[type]': 'payment_intent',
    'payment[payment_intent]': paymentIntentId,
    status: 'paid',
    limit: '2',
  });
  const payments = listData(await get(`/v1/invoice_payments?${query}`));
  const invoiceId = payments.length === 1 ? readId(payments[0]?.invoice) : null;
  if (!invoiceId) return base;

  const invoice = await get(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
  const subscriptionId = subscriptionIdOnInvoice(invoice);
  const family =
    base.familyId ?? familyFromMetadata(invoice) ?? familyFromSubscriptionDetails(invoice);
  const customerId = base.customerId ?? readId(invoice.customer);
  if (!subscriptionId) return { ...base, familyId: family, customerId };
  const subscription = await get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return {
    ...base,
    familyId: family ?? familyFromMetadata(subscription),
    customerId,
    subscriptionId,
    subscriptionStatus: readString(subscription.status)?.toLowerCase() ?? null,
    invoice: invoiceFacts(invoice),
  };
}

async function familySubscriptions(
  get: StripeRead,
  input: Parameters<StripePlanReader['familySubscriptions']>[0],
): Promise<{ subscriptions: StripeSubscriptionRead[]; truncated: boolean }> {
  const found = new Map<string, StripeObject>();
  let truncated = false;

  const customers = new Set(input.rememberedCustomerIds);
  if (input.eventCustomerId) customers.add(input.eventCustomerId);
  for (const customer of customers) {
    const query = new URLSearchParams({ customer, limit: STRIPE_LIST_LIMIT });
    try {
      const page = await get(`/v1/subscriptions?${query}`);
      if (page.has_more === true) truncated = true;
      for (const row of listData(page)) {
        const id = readId(row.id);
        if (id) found.set(id, row);
      }
    } catch (err) {
      if (customer === input.eventCustomerId || !isNotFound(err)) throw err;
    }
  }

  // Search is not read-after-write, so a hit supplies an id and the object is read fresh.
  const search = new URLSearchParams({
    query: `metadata["familyId"]:"${input.familyId}"`,
    limit: STRIPE_LIST_LIMIT,
  });
  const hits = await get(`/v1/subscriptions/search?${search}`);
  if (hits.has_more === true) truncated = true;
  const named = new Set(listData(hits).flatMap((row) => readId(row.id) ?? []));
  if (input.eventSubscriptionId) named.add(input.eventSubscriptionId);
  for (const id of named) {
    if (!found.has(id)) found.set(id, await get(`/v1/subscriptions/${encodeURIComponent(id)}`));
  }
  for (const id of input.rememberedSubscriptionIds) {
    if (found.has(id)) continue;
    try {
      found.set(id, await get(`/v1/subscriptions/${encodeURIComponent(id)}`));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  const subscriptions: StripeSubscriptionRead[] = [];
  for (const [id, row] of found) {
    const family = familyFromMetadata(row);
    if (family !== null && family !== input.familyId) continue;
    const subscription = subscriptionRead(id, row);
    if (!ENDED_SUBSCRIPTION.has(subscription.status)) {
      const period = await periodInvoices(get, subscription);
      subscription.periodInvoices = period.invoices;
      if (period.truncated) truncated = true;
    }
    subscriptions.push(subscription);
  }
  return { subscriptions, truncated };
}

function subscriptionRead(id: string, row: StripeObject): StripeSubscriptionRead {
  const items = isRecord(row.items) ? listData(row.items) : [];
  const price = items[0]?.price;
  const status = readString(row.status)?.toLowerCase();
  const customerId = readId(row.customer);
  // Stripe always sends both. Without them nothing here is safe to decide a plan on.
  if (!status || !customerId) throw new StripeLookupError('refused', null);
  return {
    id,
    status,
    priceId: isRecord(price) ? readString(price.id) : null,
    customerId,
    latestInvoiceId: readId(row.latest_invoice),
    items: items.flatMap((item) => {
      const itemId = readId(item.id);
      if (!itemId) return [];
      const end = item.current_period_end;
      return [{ id: itemId, currentPeriodEnd: typeof end === 'number' ? end : null }];
    }),
    periodInvoices: [],
  };
}

async function periodInvoices(
  get: StripeRead,
  subscription: StripeSubscriptionRead,
): Promise<{ invoices: Array<{ id: string; refunded: boolean }>; truncated: boolean }> {
  const query = new URLSearchParams({
    subscription: subscription.id,
    status: 'paid',
    limit: PERIOD_INVOICE_LIMIT,
  });
  const page = await get(`/v1/invoices?${query}`);
  const rows = listData(page).map(invoiceFacts);
  const covering = rows.filter((row) => invoicePeriodFit(row, subscription) === 'covers');
  const oldest = rows.at(-1);
  const truncated =
    page.has_more === true &&
    oldest !== undefined &&
    invoicePeriodFit(oldest, subscription) === 'covers';
  const invoices: Array<{ id: string; refunded: boolean }> = [];
  for (const row of covering) {
    invoices.push({ id: row.id, refunded: await invoiceRefunded(get, row.id) });
  }
  return { invoices, truncated };
}

/** Refunded only on proof. An invoice with no card payment counts as paid. */
async function invoiceRefunded(get: StripeRead, invoiceId: string): Promise<boolean> {
  const query = new URLSearchParams({
    invoice: invoiceId,
    status: 'paid',
    limit: PERIOD_INVOICE_LIMIT,
  });
  const page = await get(`/v1/invoice_payments?${query}`);
  const payments = listData(page);
  if (page.has_more === true || payments.length === 0) return false;
  for (const row of payments) {
    const payment = isRecord(row.payment) ? row.payment : null;
    const intentId = payment?.type === 'payment_intent' ? readId(payment.payment_intent) : null;
    if (!intentId) return false;
    const expand = new URLSearchParams({ 'expand[]': 'latest_charge' });
    const intent = await get(`/v1/payment_intents/${encodeURIComponent(intentId)}?${expand}`);
    const charge = isRecord(intent.latest_charge) ? intent.latest_charge : null;
    const chargeId = charge ? readId(charge.id) : null;
    if (!charge || !chargeId || charge.refunded !== true) return false;
    if (typeof charge.amount_captured !== 'number') return false;
    const refunds = new URLSearchParams({ charge: chargeId, limit: STRIPE_LIST_LIMIT });
    const state = refundStateOf(await get(`/v1/refunds?${refunds}`), charge.amount_captured);
    if (state.state !== 'settled') return false;
  }
  return true;
}

function refundStateOf(page: StripeObject, amountCaptured: number): RefundState {
  if (page.has_more === true) return { state: 'not_settled' };
  const refunds = listData(page);
  const succeeded = refunds
    .filter((row) => row.status === 'succeeded')
    .reduce((total, row) => total + (typeof row.amount === 'number' ? row.amount : 0), 0);
  if (amountCaptured > 0 && succeeded >= amountCaptured) return { state: 'settled' };
  if (refunds.some((row) => row.status === 'requires_action')) {
    return { state: 'pending', reason: 'requires_action' };
  }
  const pending = refunds.filter((row) => row.status === 'pending');
  if (pending.length === 0) return { state: 'not_settled' };
  const reasons = pending.map((row) => row.pending_reason);
  if (reasons.includes('insufficient_funds')) {
    return { state: 'pending', reason: 'insufficient_funds' };
  }
  const known = reasons.every((value) => value === 'processing' || value === 'charge_pending');
  if (!known) return { state: 'pending', reason: 'unknown' };
  return {
    state: 'pending',
    reason: reasons.includes('charge_pending') ? 'charge_pending' : 'processing',
  };
}

/**
 * `covers`: a line for this subscription, on a current item, ends when that item's period
 * ends. Proration lines count, which is what lets an upgrade's two invoices both be seen.
 * `item_replaced`: a line ends at the current period end on an item no longer present.
 */
export function invoicePeriodFit(
  invoice: StripeInvoiceFacts,
  subscription: Pick<StripeSubscriptionRead, 'id' | 'items'>,
): InvoicePeriodFit {
  const lines = invoice.lines.filter((line) => line.subscriptionId === subscription.id);
  const covers = lines.some((line) =>
    subscription.items.some(
      (item) =>
        item.id === line.itemId &&
        item.currentPeriodEnd !== null &&
        item.currentPeriodEnd === line.periodEnd,
    ),
  );
  if (covers) return 'covers';
  const ends = new Set(subscription.items.map((item) => item.currentPeriodEnd));
  const replaced = lines.some(
    (line) =>
      line.periodEnd !== null &&
      ends.has(line.periodEnd) &&
      !subscription.items.some((item) => item.id === line.itemId),
  );
  return replaced ? 'item_replaced' : 'older';
}

async function cancelSubscription(
  secret: string,
  subscriptionId: string,
  get: StripeRead,
  fetchImpl: typeof fetch,
): Promise<void> {
  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  let status: number | null = null;
  try {
    const res = await fetchImpl(`https://api.stripe.com${path}`, {
      method: 'DELETE',
      headers: pinnedHeaders(secret),
      signal: AbortSignal.timeout(STRIPE_LOOKUP_TIMEOUT_MS),
    });
    if (res.ok) return;
    status = res.status;
  } catch {
    status = null;
  }
  // Stripe does not document a repeated cancel, so the status read is the proof.
  const current = await get(path);
  if (readString(current.status)?.toLowerCase() === 'canceled') return;
  throw new StripeLookupError('refused', status, null, 'cancel');
}

function pinnedHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}`, 'stripe-version': STRIPE_LOOKUP_VERSION };
}

async function pinnedGet(
  secret: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<StripeObject> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.stripe.com${path}`, {
      headers: pinnedHeaders(secret),
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

function subscriptionIdOnInvoice(invoice: StripeObject): string | null {
  const parent = isRecord(invoice.parent) ? invoice.parent : null;
  if (parent?.type !== 'subscription_details' || !isRecord(parent.subscription_details)) {
    return null;
  }
  return readId(parent.subscription_details.subscription);
}

function invoiceFacts(invoice: StripeObject): StripeInvoiceFacts {
  const id = readId(invoice.id);
  if (!id) throw new StripeLookupError('refused', null);
  const lines = isRecord(invoice.lines) ? listData(invoice.lines) : [];
  return {
    id,
    billingReason: readString(invoice.billing_reason),
    lines: lines.map((line) => {
      const parent = isRecord(line.parent) ? line.parent : null;
      const details =
        parent && isRecord(parent.subscription_item_details)
          ? parent.subscription_item_details
          : null;
      const period = isRecord(line.period) ? line.period : null;
      return {
        subscriptionId: details ? readId(details.subscription) : null,
        itemId: details ? readId(details.subscription_item) : null,
        periodEnd: typeof period?.end === 'number' ? period.end : null,
      };
    }),
  };
}
