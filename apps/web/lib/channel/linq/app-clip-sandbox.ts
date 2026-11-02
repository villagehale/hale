/**
 * VIL-481 — sandbox payment requests only.
 *
 * Linq's Apple Pay checkout is a real charge on the connected Stripe account.
 * This module is the gate that keeps Hale from ever creating one: Preview, no
 * partner key, no live Stripe key, `livemode: false`, and a checkout host that
 * cannot resolve. A body that is not this shape is not answered, even by the
 * Preview capture door.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** RFC 2606. Nothing at this host can take a payment. */
export const SANDBOX_PAY_HOST = 'sandbox.pay.preview.invalid';

/**
 * Not a Stripe price. Capture refuses anything else, so a real price id never
 * leaves. The id does not name a billing period.
 */
export const SANDBOX_PRICE_IDS = {
  plus: 'price_test_sandbox_plus',
  family: 'price_test_sandbox_family',
} as const;

export type AppClipPayTier = keyof typeof SANDBOX_PRICE_IDS;

export const SANDBOX_PAYMENT_CHAT_ID = 'preview-chat-sandbox-pay';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why a payment request must not be created. `live_key` is any Linq partner key
 * (it can charge the connected account) or a Stripe secret that is not `sk_test_`.
 */
export function sandboxPaymentBlocked(env: Env = process.env): 'not_preview' | 'live_key' | null {
  if (env.VERCEL_ENV !== 'preview') return 'not_preview';
  if ((env.LINQ_API_KEY ?? '').trim().length > 0) return 'live_key';
  const stripe = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (stripe.length > 0 && !stripe.startsWith('sk_test_')) return 'live_key';
  return null;
}

export function sandboxCheckoutUrl(session: string): string {
  return `https://${SANDBOX_PAY_HOST}/pay/hale?session=${session}`;
}

/** The only checkout URL Hale will put on an App Clip card or its link fallback. */
export function isSandboxCheckoutUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const session = url.searchParams.get('session');
    return (
      url.protocol === 'https:' &&
      url.hostname === SANDBOX_PAY_HOST &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/pay/hale' &&
      session !== null &&
      /^tok_test_[0-9a-f-]{36}$/.test(session)
    );
  } catch {
    return false;
  }
}

/** The create body capture will answer. Anything else is refused before a URL exists. */
export function isSandboxPaymentBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (body.livemode !== false) return false;
  if (body.mode !== 'subscription') return false;
  if (body.amount !== undefined) return false;
  if (typeof body.description !== 'string' || body.description.trim() === '') return false;
  const priceId = body.price_id;
  if (priceId !== SANDBOX_PRICE_IDS.plus && priceId !== SANDBOX_PRICE_IDS.family) return false;
  if (!isRecord(body.metadata)) return false;
  if (body.metadata.hale_payment_mode !== 'sandbox') return false;
  const tier = body.metadata.tier;
  if (tier !== 'plus' && tier !== 'family') return false;
  return SANDBOX_PRICE_IDS[tier] === priceId;
}
