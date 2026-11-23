import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { alertBillingTierMismatch } from '~/lib/monitoring/billing-tier-alert';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import { stripeBillingRevokeEnabled, stripeRefundEndsSubscriptionEnabled } from './flags.js';

/**
 * Checkout stays 501 until Stripe can verify webhooks and at least one signed
 * event has written a plan tier (`family_plan_updated` from Stripe). A claimed
 * event that did not grant — refund-ready, blocked, unknown family — does not
 * open checkout. Dark unless STRIPE_BILLING_REVOKE_ENABLED is exactly `true`.
 */
export async function billingWebhookReady(
  database: Database,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ready: true } | { ready: false; reason: 'secret_unset' | 'no_applied_event' }> {
  if (!stripeBillingRevokeEnabled(env)) return { ready: true };
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return { ready: false, reason: 'secret_unset' };
  const rows = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'family_plan_updated'),
        sql`${schema.auditLog.after}->>'source' = 'stripe'`,
      ),
    )
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
  /** A refund or dispute could not be tied to the live subscription, and the tier is still paid. */
  revokeUnresolved: number;
  /** Families with a held plan nothing has cleared. Present only with the refund flag on. */
  planUnsettled?: number;
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
    revokeUnresolved: 0,
  };
  for (const row of rowsOf(result)) {
    const paidTier = row.plan_tier === 'plus' || row.plan_tier === 'family';
    const lastPaid = row.last_stripe_tier === 'plus' || row.last_stripe_tier === 'family';
    if (row.plan_tier === 'free' && lastPaid) mismatches.freeDespitePaid += 1;
    if (paidTier && row.last_stripe_tier === 'free') mismatches.paidDespiteRevoke += 1;
    if (paidTier && !row.stripe_customer_id) mismatches.paidWithoutCustomer += 1;
  }
  const unresolved = await database.execute(sql`
    select count(*)::int as n
    from families f
    where f.plan_tier in ('plus', 'family')
      and exists (
        select 1 from audit_log a
        where a.family_id = f.id
          and a.action_taken = 'billing_revoke_unresolved'
          and not exists (
            select 1 from audit_log later
            where later.family_id = f.id
              and later.action_taken = 'family_plan_updated'
              and later.after->>'source' = 'stripe'
              and later.after->>'planTier' = 'free'
              and later.occurred_at >= a.occurred_at
          )
      )
  `);
  const unresolvedRow = rowsOf(unresolved)[0] as { n?: number } | undefined;
  mismatches.revokeUnresolved = Number(unresolvedRow?.n ?? 0);
  if (stripeRefundEndsSubscriptionEnabled(env)) {
    mismatches.planUnsettled = await countUnsettledPlans(database);
  }

  const total =
    mismatches.freeDespitePaid +
    mismatches.paidDespiteRevoke +
    mismatches.paidWithoutCustomer +
    mismatches.revokeUnresolved +
    (mismatches.planUnsettled ?? 0);
  if (total === 0) return { status: 'checked', mismatches, opsAlert: 'not_needed' };

  const text = `billing: plan_tier disagrees with Stripe. free_despite_paid=${mismatches.freeDespitePaid} paid_despite_revoke=${mismatches.paidDespiteRevoke} paid_without_customer=${mismatches.paidWithoutCustomer} revoke_unresolved=${mismatches.revokeUnresolved}${mismatches.planUnsettled === undefined ? '' : ` plan_unsettled=${mismatches.planUnsettled}`}.`;
  const opsAlert = await alertBillingTierMismatch(text, fetchImpl);
  console.warn('billing reconcile: tier mismatch', { ...mismatches, opsAlert });
  return { status: 'checked', mismatches, opsAlert };
}

async function countUnsettledPlans(database: Database): Promise<number> {
  const result = await database.execute(sql`
    select count(*)::int as n
    from families f
    where exists (
      select 1 from audit_log held
      where held.family_id = f.id
        and held.action_taken = 'billing_plan_unsettled'
        and held.after->>'state' = 'held'
        and not exists (
          select 1 from audit_log cleared
          where cleared.family_id = f.id
            and cleared.action_taken = 'billing_plan_unsettled'
            and cleared.after->>'state' = 'cleared'
            and cleared.after->>'clearsEventId' = held.after->>'stripeEventId'
        )
    )
  `);
  const row = rowsOf(result)[0] as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}
