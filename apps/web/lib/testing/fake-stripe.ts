/**
 * An in-memory Stripe for billing tests. Every object is shaped from Stripe's API
 * reference at 2026-11-18.endive, trimmed to the fields the billing code reads. A
 * request it does not model throws, so a test can never fall through to the real API.
 */

const API_ORIGIN = 'https://api.stripe.com';

export interface FakeStripeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string | null;
}

export interface FakeSubscriptionInput {
  id: string;
  customer: string;
  familyId: string | null;
  status?: string;
  created: number;
  periodStart: number;
  periodEnd: number;
  priceId?: string;
}

export interface FakePaidInvoiceInput {
  subscriptionId: string;
  invoiceId: string;
  chargeId: string;
  paymentIntentId: string;
  periodStart: number;
  periodEnd: number;
  billingReason?: string;
  proration?: boolean;
  amount?: number;
  refunded?: boolean;
  /** False leaves the subscription's latest_invoice where it was. */
  latest?: boolean;
  /** Unix seconds. Defaults to the start of the invoiced period. */
  created?: number;
}

interface StoredCharge {
  id: string;
  object: 'charge';
  customer: string | null;
  payment_intent: string | null;
  refunded: boolean;
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  metadata: Record<string, string>;
}

export type FakeRefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

interface StoredRefund {
  id: string;
  object: 'refund';
  charge: string;
  amount: number;
  status: FakeRefundStatus;
  pending_reason: string | null;
}

interface StoredSubscription {
  id: string;
  object: 'subscription';
  customer: string;
  status: string;
  created: number;
  latest_invoice: string | null;
  metadata: Record<string, string>;
  items: {
    object: 'list';
    has_more: false;
    data: Array<{
      id: string;
      object: 'subscription_item';
      price: { id: string };
      current_period_start: number;
      current_period_end: number;
    }>;
  };
}

interface StoredInvoicePayment {
  id: string;
  object: 'invoice_payment';
  invoice: string;
  is_default: boolean;
  status: string;
  amount_paid: number;
  amount_requested: number;
  payment: { type: string; payment_intent?: string };
}

interface StoredCheckoutSession {
  id: string;
  object: 'checkout.session';
  status: 'open' | 'complete' | 'expired';
  payment_status: 'unpaid' | 'paid';
  url: string | null;
  created: number;
  expires_at: number;
  client_reference_id: string | null;
  customer: string | null;
  metadata: Record<string, string>;
  subscription: string | null;
}

interface Interceptor {
  match: (call: FakeStripeCall) => boolean;
  respond: (call: FakeStripeCall) => Response | Promise<Response>;
  remaining: number;
}

function missing(id: string): Response {
  return Response.json(
    {
      error: {
        code: 'resource_missing',
        type: 'invalid_request_error',
        message: `No such object: '${id}'`,
      },
    },
    { status: 404 },
  );
}

export function stripeError(status: number, code?: string): Response {
  return Response.json(
    { error: { code, type: 'api_error', message: 'fixture error' } },
    { status },
  );
}

export function createFakeStripe() {
  const charges = new Map<string, StoredCharge>();
  const invoices = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, StoredSubscription>();
  const invoicePayments: StoredInvoicePayment[] = [];
  const refunds: StoredRefund[] = [];
  const calls: FakeStripeCall[] = [];
  const interceptors: Interceptor[] = [];
  /** Subscription ids the search index has not caught up with. */
  const unindexed = new Set<string>();
  const checkoutSessions = new Map<string, StoredCheckoutSession>();
  /** Idempotency-Key → the body it was first sent with and the session it made. */
  const idempotent = new Map<string, { body: string; sessionId: string }>();
  let onDelete: ((subscriptionId: string) => Promise<void>) | null = null;
  const readHooks: Array<{ match: (call: FakeStripeCall) => boolean; run: () => Promise<void> }> =
    [];

  function addSubscription(input: FakeSubscriptionInput): StoredSubscription {
    const subscription: StoredSubscription = {
      id: input.id,
      object: 'subscription',
      customer: input.customer,
      status: input.status ?? 'active',
      created: input.created,
      latest_invoice: null,
      metadata: input.familyId ? { familyId: input.familyId } : {},
      items: {
        object: 'list',
        has_more: false,
        data: [
          {
            id: `si_${input.id}`,
            object: 'subscription_item',
            price: { id: input.priceId ?? 'price_plus' },
            current_period_start: input.periodStart,
            current_period_end: input.periodEnd,
          },
        ],
      },
    };
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  function addPaidInvoice(input: FakePaidInvoiceInput): void {
    const subscription = subscriptions.get(input.subscriptionId);
    if (!subscription) throw new Error(`fake stripe: no subscription ${input.subscriptionId}`);
    const amount = input.amount ?? 7900;
    const refunded = input.refunded ?? false;
    invoices.set(input.invoiceId, {
      id: input.invoiceId,
      object: 'invoice',
      customer: subscription.customer,
      status: 'paid',
      created: input.created ?? input.periodStart,
      amount_paid: amount,
      billing_reason: input.billingReason ?? 'subscription_create',
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: {
          subscription: subscription.id,
          metadata: { ...subscription.metadata },
        },
      },
      lines: {
        object: 'list',
        has_more: false,
        data: [
          {
            id: `il_${input.invoiceId}`,
            object: 'line_item',
            period: { start: input.periodStart, end: input.periodEnd },
            pricing: {
              type: 'price_details',
              price_details: { price: subscription.items.data[0]?.price.id },
            },
            parent: {
              type: 'subscription_item_details',
              invoice_item_details: null,
              subscription_item_details: {
                subscription: subscription.id,
                subscription_item: subscription.items.data[0]?.id,
                proration: input.proration ?? false,
                invoice_item: null,
              },
            },
          },
        ],
      },
    });
    charges.set(input.chargeId, {
      id: input.chargeId,
      object: 'charge',
      customer: subscription.customer,
      payment_intent: input.paymentIntentId,
      refunded,
      amount,
      amount_captured: amount,
      amount_refunded: refunded ? amount : 0,
      metadata: {},
    });
    if (refunded) addRefund(input.chargeId, amount, 'succeeded', null);
    invoicePayments.push({
      id: `inpay_${input.invoiceId}`,
      object: 'invoice_payment',
      invoice: input.invoiceId,
      is_default: true,
      status: 'paid',
      amount_paid: amount,
      amount_requested: amount,
      payment: { type: 'payment_intent', payment_intent: input.paymentIntentId },
    });
    if (input.latest !== false) subscription.latest_invoice = input.invoiceId;
  }

  function addRefund(
    chargeId: string,
    amount: number,
    status: FakeRefundStatus,
    pendingReason: string | null,
  ): StoredRefund {
    const row: StoredRefund = {
      id: `re_${refunds.length + 1}`,
      object: 'refund',
      charge: chargeId,
      amount,
      status,
      pending_reason: status === 'pending' ? pendingReason : null,
    };
    refunds.push(row);
    return row;
  }

  /** A full refund. Stripe marks the charge refunded when the refund is created. */
  function refund(
    chargeId: string,
    over: { status?: FakeRefundStatus; pendingReason?: string } = {},
  ): StoredRefund {
    const charge = charges.get(chargeId);
    if (!charge) throw new Error(`fake stripe: no charge ${chargeId}`);
    charge.refunded = true;
    charge.amount_refunded = charge.amount;
    return addRefund(
      chargeId,
      charge.amount,
      over.status ?? 'succeeded',
      over.pendingReason ?? 'processing',
    );
  }

  /** An unpaid invoice on a customer, with or without a subscription. */
  function addOpenInvoice(input: {
    id: string;
    customer: string;
    subscriptionId: string | null;
    created: number;
  }): void {
    invoices.set(input.id, {
      id: input.id,
      object: 'invoice',
      customer: input.customer,
      status: 'open',
      created: input.created,
      amount_paid: 0,
      billing_reason: input.subscriptionId ? 'subscription_cycle' : 'manual',
      parent: input.subscriptionId
        ? {
            type: 'subscription_details',
            quote_details: null,
            subscription_details: { subscription: input.subscriptionId, metadata: {} },
          }
        : null,
      lines: { object: 'list', has_more: false, data: [] },
    });
  }

  /** A Dashboard price change that swaps the item, so old invoice lines name a gone item. */
  function replaceItem(subscriptionId: string, priceId: string): void {
    const item = subscriptions.get(subscriptionId)?.items.data[0];
    if (!item) throw new Error(`fake stripe: no subscription ${subscriptionId}`);
    item.id = `si_replaced_${subscriptionId}`;
    item.price = { id: priceId };
  }

  function list(path: string, data: unknown[], hasMore = false): Response {
    return Response.json({ object: 'list', url: path, has_more: hasMore, data });
  }

  function createCheckoutSession(call: FakeStripeCall): Response {
    const body = call.body ?? '';
    const key = call.headers.get('idempotency-key');
    const prior = key ? idempotent.get(key) : undefined;
    if (prior) {
      // Stripe replays the first response for the same key and body, and refuses a key
      // sent again with different parameters.
      if (prior.body !== body) return stripeError(400, 'idempotency_key_in_use');
      return Response.json(checkoutSessions.get(prior.sessionId));
    }
    const form = new URLSearchParams(body);
    const metadata: Record<string, string> = {};
    for (const [name, value] of form) {
      const field = name.match(/^metadata\[([^\]]+)\]$/)?.[1];
      if (field) metadata[field] = value;
    }
    const id = `cs_test_${checkoutSessions.size + 1}`;
    const created = Math.floor(Date.now() / 1000);
    const session: StoredCheckoutSession = {
      id,
      object: 'checkout.session',
      status: 'open',
      payment_status: 'unpaid',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      created,
      expires_at: created + 24 * 3600,
      client_reference_id: form.get('client_reference_id'),
      customer: form.get('customer'),
      metadata,
      subscription: null,
    };
    checkoutSessions.set(id, session);
    if (key) idempotent.set(key, { body, sessionId: id });
    return Response.json(session);
  }

  function checkoutSessionRoute(call: FakeStripeCall): Response | null {
    const { method, path, query } = call;
    if (method === 'POST' && path === '/v1/checkout/sessions') return createCheckoutSession(call);
    const expire = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)?.[1];
    if (method === 'POST' && expire) {
      const session = checkoutSessions.get(expire);
      if (!session) return missing(expire);
      // Stripe expires only an open session.
      if (session.status !== 'open') return stripeError(400);
      session.status = 'expired';
      session.url = null;
      return Response.json(session);
    }
    const read = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)?.[1];
    if (method === 'GET' && read) {
      const session = checkoutSessions.get(read);
      if (!session) return missing(read);
      const expand = query.getAll('expand[]');
      const subscription =
        expand.includes('subscription') && session.subscription
          ? (subscriptions.get(session.subscription) ?? session.subscription)
          : session.subscription;
      return Response.json({ ...session, subscription });
    }
    return null;
  }

  /** The parent pays: the session completes and its subscription is live. */
  function completeCheckout(sessionId: string, subscriptionId: string): void {
    const session = checkoutSessions.get(sessionId);
    if (!session) throw new Error(`fake stripe: no checkout session ${sessionId}`);
    if (session.status !== 'open') throw new Error(`fake stripe: ${sessionId} is not open`);
    const now = Math.floor(Date.now() / 1000);
    addSubscription({
      id: subscriptionId,
      customer: session.customer ?? `cus_${sessionId}`,
      familyId: session.metadata.familyId ?? null,
      created: now,
      periodStart: now,
      periodEnd: now + 365 * 24 * 3600,
      priceId: session.metadata.priceId,
    });
    session.status = 'complete';
    session.payment_status = 'paid';
    session.url = null;
    session.subscription = subscriptionId;
  }

  async function route(call: FakeStripeCall): Promise<Response> {
    const { method, path, query } = call;
    const checkout = checkoutSessionRoute(call);
    if (checkout) return checkout;
    if (method === 'DELETE') {
      const id = path.match(/^\/v1\/subscriptions\/([^/]+)$/)?.[1];
      if (!id) throw new Error(`fake stripe: unexpected DELETE ${path}`);
      const subscription = subscriptions.get(id);
      if (!subscription) return missing(id);
      subscription.status = 'canceled';
      if (onDelete) await onDelete(id);
      return Response.json(subscription);
    }
    if (method !== 'GET') throw new Error(`fake stripe: unexpected ${method} ${path}`);

    const charge = path.match(/^\/v1\/charges\/([^/]+)$/)?.[1];
    if (charge) {
      const found = charges.get(charge);
      return found ? Response.json(found) : missing(charge);
    }

    if (path === '/v1/invoice_payments') {
      const limit = Number(query.get('limit') ?? '10');
      const status = query.get('status');
      const paymentIntent = query.get('payment[payment_intent]');
      const invoice = query.get('invoice');
      if (paymentIntent && query.get('payment[type]') !== 'payment_intent') {
        throw new Error('fake stripe: payment[type] must accompany payment[payment_intent]');
      }
      if (!paymentIntent && !invoice) throw new Error('fake stripe: unfiltered invoice_payments');
      const rows = invoicePayments.filter(
        (row) =>
          (!status || row.status === status) &&
          (!paymentIntent || row.payment.payment_intent === paymentIntent) &&
          (!invoice || row.invoice === invoice),
      );
      return list(path, rows.slice(0, limit), rows.length > limit);
    }

    if (path === '/v1/refunds') {
      const charge = query.get('charge');
      if (!charge) throw new Error('fake stripe: refund list without a charge');
      const rows = refunds.filter((row) => row.charge === charge);
      const limit = Number(query.get('limit') ?? '10');
      return list(path, rows.slice(0, limit), rows.length > limit);
    }

    if (path === '/v1/invoices') {
      const subscription = query.get('subscription');
      const customer = query.get('customer');
      const status = query.get('status');
      if (!subscription && !customer) throw new Error('fake stripe: unfiltered invoice list');
      const invoiceSubscription = (row: Record<string, unknown>) =>
        (row.parent as { subscription_details?: { subscription?: string } } | null)
          ?.subscription_details?.subscription ?? null;
      const rows = [...invoices.values()]
        .filter(
          (row) =>
            (!status || row.status === status) &&
            (!customer || row.customer === customer) &&
            (!subscription || invoiceSubscription(row) === subscription),
        )
        .sort((a, b) => Number(b.created) - Number(a.created));
      const limit = Number(query.get('limit') ?? '10');
      return list(path, rows.slice(0, limit), rows.length > limit);
    }

    const invoice = path.match(/^\/v1\/invoices\/([^/]+)$/)?.[1];
    if (invoice) {
      const found = invoices.get(invoice);
      return found ? Response.json(found) : missing(invoice);
    }

    if (path === '/v1/subscriptions') {
      const customer = query.get('customer');
      if (!customer) throw new Error('fake stripe: subscription list without a customer');
      const rows = [...subscriptions.values()].filter(
        (row) => row.customer === customer && row.status !== 'canceled',
      );
      return list(path, rows.slice(0, Number(query.get('limit') ?? '10')));
    }

    if (path === '/v1/subscriptions/search') {
      const familyId = query.get('query')?.match(/^metadata\["familyId"\]:"([^"]+)"$/)?.[1];
      if (!familyId) throw new Error(`fake stripe: unexpected search ${query.get('query')}`);
      const rows = [...subscriptions.values()].filter(
        (row) => row.metadata.familyId === familyId && !unindexed.has(row.id),
      );
      return Response.json({ object: 'search_result', url: path, has_more: false, data: rows });
    }

    const subscription = path.match(/^\/v1\/subscriptions\/([^/]+)$/)?.[1];
    if (subscription) {
      const found = subscriptions.get(subscription);
      return found ? Response.json(found) : missing(subscription);
    }

    const intent = path.match(/^\/v1\/payment_intents\/([^/]+)$/)?.[1];
    if (intent) {
      if (query.get('expand[]') !== 'latest_charge') {
        throw new Error('fake stripe: payment_intent read without expand[]=latest_charge');
      }
      const latest = [...charges.values()].find((row) => row.payment_intent === intent);
      if (!latest) return missing(intent);
      return Response.json({
        id: intent,
        object: 'payment_intent',
        status: 'succeeded',
        latest_charge: {
          id: latest.id,
          object: 'charge',
          refunded: latest.refunded,
          amount: latest.amount,
          amount_captured: latest.amount_captured,
          amount_refunded: latest.amount_refunded,
        },
      });
    }

    throw new Error(`fake stripe: unexpected GET ${path}`);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== API_ORIGIN) throw new Error(`fake stripe: unexpected origin ${url.origin}`);
    const call: FakeStripeCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const hookIndex = readHooks.findIndex((hook) => hook.match(call));
    if (hookIndex >= 0) {
      const [hook] = readHooks.splice(hookIndex, 1);
      await hook?.run();
    }
    for (const interceptor of interceptors) {
      if (interceptor.remaining > 0 && interceptor.match(call)) {
        interceptor.remaining -= 1;
        return interceptor.respond(call);
      }
    }
    return route(call);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    charges,
    invoices,
    subscriptions,
    invoicePayments,
    refunds,
    unindexed,
    checkoutSessions,
    completeCheckout,
    /** Sessions a parent could still pay, for one family. */
    payableCheckoutSessions(familyId: string): StoredCheckoutSession[] {
      return [...checkoutSessions.values()].filter(
        (session) => session.status === 'open' && session.metadata.familyId === familyId,
      );
    },
    addSubscription,
    addPaidInvoice,
    addOpenInvoice,
    replaceItem,
    refund,
    /** Answers matching requests from here on, up to `times` of them. */
    intercept(
      match: (call: FakeStripeCall) => boolean,
      respond: (call: FakeStripeCall) => Response | Promise<Response>,
      times = Number.POSITIVE_INFINITY,
    ): void {
      interceptors.push({ match, respond, remaining: times });
    },
    clearIntercepts(): void {
      interceptors.length = 0;
    },
    /** Runs once, before the first matching request is answered: a commit mid-read. */
    beforeRead(match: (call: FakeStripeCall) => boolean, run: () => Promise<void>): void {
      readHooks.push({ match, run });
    },
    /** Runs while a DELETE is in flight, after Stripe has cancelled the subscription. */
    duringDelete(hook: (subscriptionId: string) => Promise<void>): void {
      onDelete = hook;
    },
    deletes(): string[] {
      return calls
        .filter((call) => call.method === 'DELETE')
        .map((call) => call.path.replace('/v1/subscriptions/', ''));
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
