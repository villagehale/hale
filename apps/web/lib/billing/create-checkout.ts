import { type Database, schema } from '@hale/db';
import type { Attribution, BillingCurrency, BillingPeriod } from '@hale/types';
import { eq } from 'drizzle-orm';
import { type FunnelSender, captureFunnelEvent, posthogFunnelSender } from '~/lib/analytics/funnel';
import { requireUserIdForUser, resolveFamilyForUser } from '~/lib/family';
import type { PaidTier } from '~/lib/webhooks/stripe-billing';
import type { AdsCheckoutContext } from './ads-context.js';
import { familyAlreadySubscribed } from './already-subscribed.js';
import { checkoutCancelUrl, checkoutSuccessUrl } from './checkout-session.js';
import { checkoutSuccessStatesEnabled, holidayPromoEnabled } from './flags.js';
import {
  type CheckoutSku,
  foundingWindowOpen,
  isPromoAnnualSku,
  isPromoPriceId,
} from './prices.js';
import { isPromoPreviewFamily } from './promo-preview.js';
import type { StripeCheckoutClient } from './stripe-client.js';

/**
 * Creates a Stripe Checkout session for the caller's family and records the
 * billing intent (rule #6). Pure of env/auth reads — the route owns the auth gate,
 * the Stripe-configured gate, and price/client/identity resolution, then injects
 * them here — so this is exercised with fakes (no live Stripe, no real DB).
 *
 * Returns not_found (and creates nothing) when the caller has no family, matching
 * the other family-scoped mutations. already_paid when the family is on plus or
 * family — a leftover stripeSubscriptionId after cancel/delete is not live.
 * Duplicate live subscriptions are blocked by that tier check plus reusing the
 * Stripe Customer. The audit row is the billing intent, written once the session
 * is created.
 */
export type CreateBillingCheckoutResult =
  | { status: 'created'; url: string }
  | { status: 'not_found' }
  | { status: 'already_paid' }
  | { status: 'founding_only' };

export { familyAlreadySubscribed } from './already-subscribed.js';

export async function createBillingCheckout(input: {
  tier: PaidTier;
  period: BillingPeriod;
  priceId: string;
  externalAuthId: string;
  /**
   * Prefills the Stripe page, and is allowed to be absent. A family that arrived by
   * text has no address on file (`users.email` is NULL by construction), and refusing
   * checkout over that would lock every phone-born family out of paying forever —
   * Stripe collects one on its own page instead, which is where a billing address
   * belongs anyway.
   */
  customerEmail: string | null;
  database: Database;
  client: StripeCheckoutClient;
  origin: string;
  /** Marketing origin — Google Ads gtag lives on villagehale.com, not the app. */
  marketingOrigin: string;
  sku?: CheckoutSku;
  currency?: BillingCurrency;
  attribution?: Attribution;
  adsContext?: AdsCheckoutContext;
  /** When set, skip the session family lookup (the ads new-visitor path). */
  familyId?: string;
  /**
   * Defaults to the settings billing hash. The public join page passes a cancel
   * URL back to /join. With CHECKOUT_SUCCESS_STATES_ENABLED every checkout
   * cancels to the pricing page instead.
   */
  cancelUrl?: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  /** checkout_started goes out through this; defaults to PostHog. */
  funnel?: FunnelSender;
  /**
   * The app's analytics opt-out cookie was on this request. Checkout still
   * proceeds; the family-linked PostHog event does not.
   */
  analyticsOptOut?: boolean;
}): Promise<CreateBillingCheckoutResult> {
  const {
    tier,
    period,
    priceId,
    externalAuthId,
    customerEmail,
    database,
    client,
    origin,
    marketingOrigin,
    sku,
    currency,
    attribution,
    adsContext,
  } = input;

  const familyId = input.familyId ?? (await resolveFamilyForUser(externalAuthId, database));
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await requireUserIdForUser(externalAuthId, database);

  const [family] = await database
    .select({
      planTier: schema.families.planTier,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
      stripeCustomerId: schema.families.stripeCustomerId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) {
    return { status: 'not_found' };
  }
  if (familyAlreadySubscribed(family)) {
    return { status: 'already_paid' };
  }

  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const promoActive =
    foundingWindowOpen(now, env) &&
    (holidayPromoEnabled(env) || isPromoPreviewFamily(familyId, env));
  if (promoActive && (!isPromoPriceId(priceId, env) || period !== 'annual')) {
    return { status: 'founding_only' };
  }

  const { url } = await client.createCheckoutSession({
    priceId,
    familyId,
    tier,
    period,
    successUrl: checkoutSuccessUrl(marketingOrigin),
    cancelUrl: checkoutSuccessStatesEnabled(env)
      ? checkoutCancelUrl(marketingOrigin)
      : (input.cancelUrl ??
        (sku && isPromoAnnualSku(sku)
          ? `${origin}/settings/founding?checkout=cancelled`
          : `${origin}/settings?checkout=cancelled#billing`)),
    customerEmail: family.stripeCustomerId ? null : customerEmail,
    customerId: family.stripeCustomerId,
    sku,
    currency,
    attribution,
    adsContext,
  });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: userId,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: familyId,
    after: { tier, period, sku: sku ?? null, currency: currency ?? null },
  });

  if (!input.analyticsOptOut) {
    await captureFunnelEvent(
      {
        event: 'checkout_started',
        familyId,
        attribution: attribution ?? {},
        properties: { plan: tier, period },
      },
      { sender: input.funnel ?? posthogFunnelSender, env },
    );
  }

  return { status: 'created', url };
}
