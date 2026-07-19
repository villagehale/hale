import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import {
  eventIdFromStripeEvent,
  familyIdFromStripeEvent,
  planTierFromStripeEvent,
  priceTierMapFromEnv,
  type PriceTierMap,
} from './stripe-billing.js';

/**
 * Applies a VERIFIED Stripe billing event to the family's plan_tier. Called only
 * after the route's signature gate returns `verified` — this never authenticates.
 *
 * Exactly-once by construction: the event id is claimed in stripe_billing_events
 * inside the SAME transaction as the plan_tier write + audit row, so a redelivered
 * event (Stripe retries every non-2xx) conflicts on the unique index and applies
 * nothing a second time. An event that maps to no tier (unrelated type / unknown
 * price) or carries no family reference writes nothing — an unknown price must
 * never silently grant a tier (rule #1), and an unattributable event has no family
 * to write. Every applied transition writes an immutable audit_log row (rule #6).
 */
export type ApplyStripeBillingResult =
  | { status: 'applied'; tier: PlanTier }
  | { status: 'duplicate' }
  | { status: 'no_tier' }
  | { status: 'unbound' }
  | { status: 'ignored' };

export async function applyStripeBillingEvent(
  event: unknown,
  database: Database = defaultDb(),
  priceTierMap: PriceTierMap = priceTierMapFromEnv(),
): Promise<ApplyStripeBillingResult> {
  const eventId = eventIdFromStripeEvent(event);
  if (!eventId) {
    return { status: 'ignored' };
  }
  const tier = planTierFromStripeEvent(event, priceTierMap);
  if (tier === null) {
    return { status: 'no_tier' };
  }
  const familyId = familyIdFromStripeEvent(event);
  if (!familyId) {
    return { status: 'unbound' };
  }

  return database.transaction(async (tx) => {
    const claim = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    if (claim.length === 0) {
      return { status: 'duplicate' };
    }

    const existing = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    await tx
      .update(schema.families)
      .set({ planTier: tier })
      .where(eq(schema.families.id, familyId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: existing[0]?.planTier ?? null },
      after: { planTier: tier, source: 'stripe', stripeEventId: eventId },
    });

    return { status: 'applied', tier };
  });
}
