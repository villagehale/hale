import { APP_URL } from '~/lib/app-url';

/**
 * What the success page needs from hale-web. The browser never calls the app.
 * `direct` is true only for a paid pricing_direct session. A missing or odd
 * payload is "not this flow", so a founding checkout keeps the page it has.
 */

export type PricingCheckoutOpen = {
  direct: true;
  bound: boolean;
  phone: string | null;
  tier: 'plus' | 'family' | null;
  status: string;
  retryAfterMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pricingCheckoutOpenFromJson(payload: unknown): PricingCheckoutOpen | null {
  if (!isRecord(payload) || payload.direct !== true) return null;
  const tier = payload.tier === 'plus' || payload.tier === 'family' ? payload.tier : null;
  const phone = typeof payload.phone === 'string' ? payload.phone : null;
  const status = typeof payload.status === 'string' ? payload.status : 'send_failed';
  const retryAfterMs = typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : undefined;
  return {
    direct: true,
    bound: payload.bound === true,
    phone,
    tier,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export async function openPricingCheckout(
  sessionId: string,
  appUrl: string = APP_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<PricingCheckoutOpen | null> {
  const url = `${appUrl.replace(/\/$/, '')}/api/billing/pricing-checkout/open`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return pricingCheckoutOpenFromJson(await res.json());
  } catch {
    return null;
  }
}
