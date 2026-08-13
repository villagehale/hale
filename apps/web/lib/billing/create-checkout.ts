import { type Database, schema } from '@hale/db';
import type { BillingPeriod } from '@hale/types';
import { requireUserIdForUser, resolveFamilyForUser } from '~/lib/family';
import type { PaidTier } from '~/lib/webhooks/stripe-billing';
import type { StripeCheckoutClient } from './stripe-client.js';

/**
 * Creates a Stripe Checkout session for the caller's family and records the
 * billing intent (rule #6). Pure of env/auth reads — the route owns the auth gate,
 * the Stripe-configured gate, and price/client/identity resolution, then injects
 * them here — so this is exercised with fakes (no live Stripe, no real DB).
 *
 * Returns not_found (and creates nothing) when the caller has no family, matching
 * the other family-scoped mutations. The audit row is the billing intent — the
 * user chose to upgrade — written once the session is created.
 */
export type CreateBillingCheckoutResult =
  | { status: 'created'; url: string }
  | { status: 'not_found' };

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
}): Promise<CreateBillingCheckoutResult> {
  const { tier, period, priceId, externalAuthId, customerEmail, database, client, origin } = input;

  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await requireUserIdForUser(externalAuthId, database);

  const { url } = await client.createCheckoutSession({
    priceId,
    familyId,
    tier,
    period,
    successUrl: `${origin}/settings?checkout=success#billing`,
    cancelUrl: `${origin}/settings?checkout=cancelled#billing`,
    customerEmail,
  });

  await database.insert(schema.auditLog).values({
    familyId,
    actor: userId,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: familyId,
    after: { tier, period },
  });

  return { status: 'created', url };
}
