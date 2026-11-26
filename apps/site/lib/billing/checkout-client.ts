import { fireMetaInitiateCheckout } from '~/lib/analytics/meta-browser';

/** Set on the consented click fetch. A plain navigation stays a 303. */
export const CHECKOUT_JSON_HEADER = 'x-hale-checkout';

function stripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Consented click: create the session, fire InitiateCheckout with its id, then
 * go to Stripe. Without the pixel, the caller follows the link and the server
 * still sends CAPI on that GET. A failed fetch falls back to the same GET.
 */
export async function openDirectCheckout(input: {
  href: string;
  fbq: ((...args: unknown[]) => void) | undefined;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetchImpl?: typeof fetch;
  assign: (url: string) => void;
}): Promise<void> {
  try {
    const res = await (input.fetchImpl ?? fetch)(input.href, {
      headers: { accept: 'application/json', [CHECKOUT_JSON_HEADER]: 'json' },
      credentials: 'same-origin',
    });
    const json = (await res.json()) as {
      url?: unknown;
      sessionId?: unknown;
      value?: unknown;
      currency?: unknown;
    };
    const url = stripeCheckoutUrl(json.url);
    const sessionId = typeof json.sessionId === 'string' ? json.sessionId : null;
    const currency = json.currency === 'CAD' || json.currency === 'USD' ? json.currency : null;
    const value = typeof json.value === 'number' ? json.value : null;
    if (url && sessionId && currency && value !== null) {
      fireMetaInitiateCheckout({ eventId: sessionId, value, currency }, input.fbq, input.storage);
    }
    if (url) {
      input.assign(url);
      return;
    }
  } catch {
    // The GET below still creates one session.
  }
  input.assign(input.href);
}
