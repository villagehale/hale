import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { type OpsPageOutcome, postOpsSlack } from '~/lib/monitoring/ops-slack';
import { stripeBillingRevokeEnabled } from './flags.js';

/**
 * Checkout stays 501 until Stripe can verify webhooks and at least one signed
 * event has been claimed in stripe_billing_events. Dark unless
 * STRIPE_BILLING_REVOKE_ENABLED is exactly `true`.
 */
export async function billingWebhookReady(
  database: Database,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ready: true } | { ready: false; reason: 'secret_unset' | 'no_applied_event' }> {
  if (!stripeBillingRevokeEnabled(env)) return { ready: true };
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return { ready: false, reason: 'secret_unset' };
  const rows = await database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .limit(1);
  if (rows.length === 0) return { ready: false, reason: 'no_applied_event' };
  return { ready: true };
}

export interface BillingTierMismatchCounts {
  /** Last Stripe grant is plus or family, but plan_tier is free. */
  freeDespitePaid: number;
  /** Last Stripe grant is free, but plan_tier is still paid. */
  paidDespiteRevoke: number;
  /** plan_tier is paid and there is no Stripe customer. */
  paidWithoutCustomer: number;
}

export type ReconcileBillingTiersResult =
  | { status: 'flag_off' }
  | {
      status: 'checked';
      mismatches: BillingTierMismatchCounts;
      opsAlert: OpsPageOutcome | 'not_needed';
    };

interface MismatchRow {
  plan_tier: string;
  stripe_customer_id: string | null;
  last_stripe_tier: string | null;
}

function rowsOf(result: unknown): MismatchRow[] {
  if (Array.isArray(result)) return result as MismatchRow[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: MismatchRow[] }).rows;
    return rows ?? [];
  }
  return [];
}

/**
 * Paid parents on Free limits, and refunds that did not drop the tier.
 * Counts only — the #ops page does not include a family id.
 */
export async function reconcileBillingTiers(
  database: Database,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ReconcileBillingTiersResult> {
  if (!stripeBillingRevokeEnabled(env)) return { status: 'flag_off' };

  const result = await database.execute(sql`
    select f.plan_tier,
           f.stripe_customer_id,
           (
             select a.after->>'planTier'
             from audit_log a
             where a.family_id = f.id
               and a.action_taken = 'family_plan_updated'
               and a.after->>'source' = 'stripe'
             order by a.occurred_at desc
             limit 1
           ) as last_stripe_tier
    from families f
    where f.plan_tier in ('plus', 'family')
       or f.stripe_customer_id is not null
  `);
  const mismatches: BillingTierMismatchCounts = {
    freeDespitePaid: 0,
    paidDespiteRevoke: 0,
    paidWithoutCustomer: 0,
  };
  for (const row of rowsOf(result)) {
    const paidTier = row.plan_tier === 'plus' || row.plan_tier === 'family';
    const lastPaid = row.last_stripe_tier === 'plus' || row.last_stripe_tier === 'family';
    if (row.plan_tier === 'free' && lastPaid) mismatches.freeDespitePaid += 1;
    if (paidTier && row.last_stripe_tier === 'free') mismatches.paidDespiteRevoke += 1;
    if (paidTier && !row.stripe_customer_id) mismatches.paidWithoutCustomer += 1;
  }

  const total =
    mismatches.freeDespitePaid + mismatches.paidDespiteRevoke + mismatches.paidWithoutCustomer;
  if (total === 0) return { status: 'checked', mismatches, opsAlert: 'not_needed' };

  const text = `billing: plan_tier disagrees with Stripe. free_despite_paid=${mismatches.freeDespitePaid} paid_despite_revoke=${mismatches.paidDespiteRevoke} paid_without_customer=${mismatches.paidWithoutCustomer}.`;
  const opsAlert = await postOpsSlack(text, fetchImpl);
  console.warn('billing reconcile: tier mismatch', { ...mismatches, opsAlert });
  return { status: 'checked', mismatches, opsAlert };
}
