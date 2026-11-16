import {
  familyPriceIdsFromEnv,
  foundingPriceIdsFromEnv,
  foundingWindowOpen,
  listPriceIdsFromEnv,
} from './prices.js';

/**
 * Promo-window grant gate for paid Stripe Checkout Sessions (and a Payment Link
 * subscription.created that carries a list price).
 *
 * During the window the only allowed new-checkout prices are the founding CAD/USD
 * yearly ids. A list monthly/annual id, an unknown id, or a Payment Link with no
 * visible founding price must not grant Plus. After the cutoff, list prices are
 * allowed again; in-flight founding ids still grant.
 */

export type DisallowedPriceReason = 'list_price' | 'unknown_price' | 'payment_link';

export type SessionPriceDecision =
  | { status: 'allow' }
  | {
      status: 'disallowed';
      priceIds: string[];
      reason: DisallowedPriceReason;
      sessionId: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pushPriceId(ids: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    ids.add(value);
    return;
  }
  if (isRecord(value)) {
    const id = readString(value.id);
    if (id) ids.add(id);
  }
}

/** Price ids on a Checkout Session: line_items when present, else metadata.priceId. */
export function paidSessionPriceIds(object: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const metadata = isRecord(object.metadata) ? object.metadata : null;
  if (metadata) {
    const fromMeta = readString(metadata.priceId);
    if (fromMeta) ids.add(fromMeta);
  }
  const lineItems = isRecord(object.line_items) ? object.line_items.data : undefined;
  if (Array.isArray(lineItems)) {
    for (const item of lineItems) {
      if (!isRecord(item)) continue;
      pushPriceId(ids, item.price);
    }
  }
  return [...ids];
}

function subscriptionPriceId(object: Record<string, unknown>): string | null {
  const items = isRecord(object.items) ? object.items.data : undefined;
  if (Array.isArray(items) && isRecord(items[0])) {
    const price = items[0].price;
    if (typeof price === 'string') return price;
    if (isRecord(price)) return readString(price.id);
  }
  return null;
}

function invoiceLinePriceId(object: Record<string, unknown>): string | null {
  const lines = isRecord(object.lines) ? object.lines.data : undefined;
  if (!Array.isArray(lines) || !isRecord(lines[0])) return null;
  const line = lines[0];
  if (typeof line.price === 'string') return line.price;
  if (isRecord(line.price)) {
    const id = readString(line.price.id);
    if (id) return id;
  }
  const pricing = isRecord(line.pricing) ? line.pricing.price_details : undefined;
  if (isRecord(pricing)) return readString(pricing.price);
  return null;
}

function eventObject(payload: unknown): { type: string; object: Record<string, unknown> } | null {
  if (!isRecord(payload)) return null;
  const type = readString(payload.type);
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!type || !isRecord(object)) return null;
  return { type, object };
}

/**
 * Whether this paid event may grant a paid tier.
 *
 * checkout.session.completed: every visible price must be in the window's allowed
 * set. A Payment Link with no founding price during the window is refused.
 * customer.subscription.created: a list price during the window is refused (the
 * Payment Link completion path).
 */
export function decidePaidSessionGrant(
  payload: unknown,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): SessionPriceDecision {
  const event = eventObject(payload);
  if (!event) return { status: 'allow' };

  const founding = new Set(foundingPriceIdsFromEnv(env));
  const list = new Set([...listPriceIdsFromEnv(env), ...familyPriceIdsFromEnv(env)]);
  const windowOpen = foundingWindowOpen(now, env);

  if (event.type === 'customer.subscription.created' && windowOpen) {
    const priceId = subscriptionPriceId(event.object);
    if (priceId && list.has(priceId)) {
      return {
        status: 'disallowed',
        priceIds: [priceId],
        reason: 'list_price',
        sessionId: null,
      };
    }
    return { status: 'allow' };
  }

  if (event.type === 'invoice.paid' && windowOpen) {
    const billingReason = readString(event.object.billing_reason);
    const priceId = invoiceLinePriceId(event.object);
    if (billingReason === 'subscription_create' && priceId && list.has(priceId)) {
      return {
        status: 'disallowed',
        priceIds: [priceId],
        reason: 'list_price',
        sessionId: readString(event.object.id),
      };
    }
    return { status: 'allow' };
  }

  if (event.type !== 'checkout.session.completed') return { status: 'allow' };

  const priceIds = paidSessionPriceIds(event.object);
  const paymentLink = readString(event.object.payment_link);
  const sessionId = readString(event.object.id);
  const allowed = windowOpen ? founding : new Set([...founding, ...list]);

  if (priceIds.some((id) => !allowed.has(id))) {
    const reason: DisallowedPriceReason = priceIds.some((id) => list.has(id))
      ? 'list_price'
      : 'unknown_price';
    return { status: 'disallowed', priceIds, reason, sessionId };
  }

  if (windowOpen && paymentLink && !priceIds.some((id) => founding.has(id))) {
    return { status: 'disallowed', priceIds, reason: 'payment_link', sessionId };
  }

  return { status: 'allow' };
}
