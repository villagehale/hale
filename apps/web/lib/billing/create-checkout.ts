import { type Database, schema } from '@hale/db';
import type { BillingPeriod } from '@hale/types';
import { type AuthIdentity, ensureUserRow, resolveFamilyForUser } from '~/lib/family';
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
  identity: AuthIdentity;
  database: Database;
  client: StripeCheckoutClient;
  origin: string;
}): Promise<CreateBillingCheckoutResult> {
  const { tier, period, priceId, identity, database, client, origin } = input;

  const familyId = await resolveFamilyForUser(identity.externalAuthId, database);
  if (!familyId) {
    return { status: 'not_found' };
  }
  const userId = await ensureUserRow(identity, database);

  const { url } = await client.createCheckoutSession({
    priceId,
    familyId,
    tier,
    period,
    successUrl: `${origin}/settings?checkout=success#billing`,
    cancelUrl: `${origin}/settings?checkout=cancelled#billing`,
    customerEmail: identity.email,
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
