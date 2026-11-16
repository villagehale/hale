/**
 * Live Stripe lockdown for the founding promo window.
 *
 * Lists every active Payment Link and every open Checkout Session whose price
 * is not one of the four promo yearly ids. Dry-run by default; `--apply`
 * deactivates those links and expires those sessions. Ids and counts only —
 * never secrets.
 */

export interface PromoLockdownLink {
  readonly id: string;
}

export interface PromoLockdownSession {
  readonly id: string;
  readonly priceIds: readonly string[];
}

export interface PromoLockdownApi {
  listActivePaymentLinks(): Promise<PromoLockdownLink[]>;
  listOpenCheckoutSessions(): Promise<PromoLockdownSession[]>;
  deactivatePaymentLink(id: string): Promise<void>;
  expireCheckoutSession(id: string): Promise<void>;
}

export type PromoLockdownAction = 'deactivate' | 'would_deactivate' | 'expire' | 'would_expire';

export interface PromoLockdownResult {
  readonly apply: boolean;
  readonly paymentLinkCount: number;
  readonly sessionCount: number;
  readonly paymentLinks: ReadonlyArray<{ id: string; action: 'deactivate' | 'would_deactivate' }>;
  readonly sessions: ReadonlyArray<{
    id: string;
    priceIds: readonly string[];
    action: 'expire' | 'would_expire';
  }>;
}

export function sessionNeedsExpiry(
  session: PromoLockdownSession,
  foundingPriceIds: ReadonlySet<string>,
): boolean {
  if (foundingPriceIds.size === 0) return true;
  if (session.priceIds.length === 0) return true;
  return session.priceIds.some((id) => !foundingPriceIds.has(id));
}

export async function runPromoLockdown(input: {
  api: PromoLockdownApi;
  foundingPriceIds: ReadonlySet<string>;
  apply: boolean;
}): Promise<PromoLockdownResult> {
  const links = await input.api.listActivePaymentLinks();
  const open = await input.api.listOpenCheckoutSessions();
  const sessions = open.filter((session) => sessionNeedsExpiry(session, input.foundingPriceIds));

  if (input.apply) {
    for (const link of links) {
      await input.api.deactivatePaymentLink(link.id);
    }
    for (const session of sessions) {
      await input.api.expireCheckoutSession(session.id);
    }
  }

  return {
    apply: input.apply,
    paymentLinkCount: links.length,
    sessionCount: sessions.length,
    paymentLinks: links.map((link) => ({
      id: link.id,
      action: input.apply ? 'deactivate' : 'would_deactivate',
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      priceIds: session.priceIds,
      action: input.apply ? 'expire' : 'would_expire',
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sessionPriceIdsFromStripe(object: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const metadata = isRecord(object.metadata) ? object.metadata : null;
  const fromMeta = metadata ? readString(metadata.priceId) : null;
  if (fromMeta) ids.add(fromMeta);
  const lineItems = isRecord(object.line_items) ? object.line_items.data : undefined;
  if (Array.isArray(lineItems)) {
    for (const item of lineItems) {
      if (!isRecord(item)) continue;
      if (typeof item.price === 'string') ids.add(item.price);
      else if (isRecord(item.price)) {
        const id = readString(item.price.id);
        if (id) ids.add(id);
      }
    }
  }
  return [...ids];
}

async function stripeJson(
  secret: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`stripe ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function listPages(
  secret: string,
  path: string,
  extra: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const data: unknown[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '100', ...extra });
    if (startingAfter) query.set('starting_after', startingAfter);
    const json = (await stripeJson(
      secret,
      `${path}?${query.toString()}`,
      { method: 'GET' },
      fetchImpl,
    )) as {
      data?: unknown[];
      has_more?: boolean;
    };
    const batch = json.data ?? [];
    data.push(...batch);
    if (!json.has_more || batch.length === 0) break;
    const last = batch[batch.length - 1] as { id?: string };
    if (!last?.id) break;
    startingAfter = last.id;
  }
  return data;
}

/** Live Stripe adapter. The CLI is the only caller. */
export function stripePromoLockdownApiFromSecret(
  secret: string,
  fetchImpl: typeof fetch = fetch,
): PromoLockdownApi {
  return {
    async listActivePaymentLinks() {
      const rows = await listPages(secret, 'payment_links', { active: 'true' }, fetchImpl);
      return rows.flatMap((row) => {
        const id = isRecord(row) ? readString(row.id) : null;
        return id ? [{ id }] : [];
      });
    },
    async listOpenCheckoutSessions() {
      const rows = await listPages(
        secret,
        'checkout/sessions',
        { status: 'open', 'expand[]': 'data.line_items' },
        fetchImpl,
      );
      return rows.flatMap((row) => {
        if (!isRecord(row)) return [];
        const id = readString(row.id);
        if (!id) return [];
        return [{ id, priceIds: sessionPriceIdsFromStripe(row) }];
      });
    },
    async deactivatePaymentLink(id) {
      await stripeJson(
        secret,
        `payment_links/${id}`,
        { method: 'POST', body: new URLSearchParams({ active: 'false' }).toString() },
        fetchImpl,
      );
    },
    async expireCheckoutSession(id) {
      await stripeJson(
        secret,
        `checkout/sessions/${id}/expire`,
        { method: 'POST', body: '' },
        fetchImpl,
      );
    },
  };
}
