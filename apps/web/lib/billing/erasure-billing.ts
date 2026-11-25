import { type Database, schema } from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type FailurePageDeps, type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import { CUSTOMER_MEMORY_VERBS } from '~/lib/webhooks/settle-family-plan';
import { ENDED_SUBSCRIPTION } from '~/lib/webhooks/stripe-billing';
import { stripeBillingRevokeEnabled, stripeRefundEndsSubscriptionEnabled } from './flags';
import { StripeLookupError, stripePlanReaderFromEnv } from './stripe-charge-context';

/**
 * A family that is erased must not go on being billed. With both refund flags on, the
 * deletion sweep ends every subscription Stripe still has for the family before the row
 * goes, through the same cancel the refund path uses: at once, no proration, nothing
 * invoiced. A subscription set to end at period end could still be resumed and charge a
 * family that no longer exists. When Stripe will not end one, the family is kept for the
 * next sweep and #ops is paged, so it is never erased while still billed.
 */

type NotEndedReason = 'no_key' | 'stripe_refused' | 'stripe_unavailable' | 'truncated';

export type ErasureBillingOutcome =
  | { status: 'off' }
  | { status: 'nothing_on_file' }
  | { status: 'ended'; cancelled: number }
  | { status: 'not_ended'; reason: NotEndedReason; opsAlert: OpsPagerOutcome };

export interface ErasureBillingDeps {
  env?: Record<string, string | undefined>;
  stripeFetch?: typeof fetch;
  pageDeps?: FailurePageDeps;
}

export async function endBillingForFamilyErasure(
  database: Database,
  familyId: string,
  deps: ErasureBillingDeps = {},
): Promise<ErasureBillingOutcome> {
  const env = deps.env ?? process.env;
  if (!stripeBillingRevokeEnabled(env) || !stripeRefundEndsSubscriptionEnabled(env)) {
    return { status: 'off' };
  }
  const notEnded = async (reason: NotEndedReason): Promise<ErasureBillingOutcome> => ({
    status: 'not_ended',
    reason,
    opsAlert: await pageOps(
      database,
      { site: 'erasure_billing_not_ended', facts: { reason } },
      deps.pageDeps,
    ),
  });

  const [family] = await database
    .select({
      customerId: schema.families.stripeCustomerId,
      subscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  const remembered = await database
    .select({ customerId: sql<string | null>`${schema.auditLog.after}->>'stripeCustomerId'` })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        inArray(schema.auditLog.actionTaken, [...CUSTOMER_MEMORY_VERBS]),
      ),
    );
  const customerIds = [
    ...new Set(
      [family?.customerId, ...remembered.map((row) => row.customerId)].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
  const subscriptionIds = family?.subscriptionId ? [family.subscriptionId] : [];
  // The same rule the plan settle follows: with no Stripe identity there is nothing to read.
  if (customerIds.length === 0 && subscriptionIds.length === 0) {
    return { status: 'nothing_on_file' };
  }

  const reader = stripePlanReaderFromEnv(env, deps.stripeFetch);
  if (!reader) return notEnded('no_key');
  try {
    const { subscriptions, truncated } = await reader.familySubscriptions({
      familyId,
      eventCustomerId: null,
      eventSubscriptionId: null,
      rememberedCustomerIds: customerIds,
      rememberedSubscriptionIds: subscriptionIds,
    });
    let cancelled = 0;
    for (const subscription of subscriptions) {
      if (ENDED_SUBSCRIPTION.has(subscription.status)) continue;
      await reader.cancelSubscription(subscription.id);
      cancelled += 1;
    }
    if (truncated) return notEnded('truncated');
    return { status: 'ended', cancelled };
  } catch (err) {
    if (!(err instanceof StripeLookupError)) throw err;
    return notEnded(err.kind === 'transient' ? 'stripe_unavailable' : 'stripe_refused');
  }
}
