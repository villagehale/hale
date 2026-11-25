import { type Database, schema } from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GOOGLE_REVOKE_PENDING_RETENTION_MS } from '~/lib/integrations/google-disconnect';
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
 * next sweep and #ops is paged, but only for the erasure wait the sweep also gives Google:
 * past it the family is erased anyway and #ops is paged with its id, the id each of its
 * subscriptions carries as metadata.familyId, so the deletion window still has an end.
 */

type NotEndedReason = 'no_key' | 'stripe_refused' | 'stripe_unavailable' | 'truncated';

export type ErasureBillingOutcome =
  | { status: 'off' }
  | { status: 'ended'; cancelled: number }
  | { status: 'not_ended'; reason: NotEndedReason; opsAlert: OpsPagerOutcome }
  | { status: 'erased_not_ended'; reason: NotEndedReason; opsAlert: OpsPagerOutcome };

export interface ErasureBillingDeps {
  env?: Record<string, string | undefined>;
  now?: Date;
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
  const [family] = await database
    .select({
      customerId: schema.families.stripeCustomerId,
      subscriptionId: schema.families.stripeSubscriptionId,
      scheduledDeletionAt: schema.families.scheduledDeletionAt,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  const now = deps.now ?? new Date();
  const pastWait =
    family?.scheduledDeletionAt != null &&
    now.getTime() - family.scheduledDeletionAt.getTime() >= GOOGLE_REVOKE_PENDING_RETENTION_MS;
  const notEnded = async (reason: NotEndedReason): Promise<ErasureBillingOutcome> =>
    pastWait
      ? {
          status: 'erased_not_ended',
          reason,
          opsAlert: await pageOps(
            database,
            { site: 'erasure_billing_erased_not_ended', facts: { reason }, ref: familyId },
            deps.pageDeps,
          ),
        }
      : {
          status: 'not_ended',
          reason,
          opsAlert: await pageOps(
            database,
            { site: 'erasure_billing_not_ended', facts: { reason } },
            deps.pageDeps,
          ),
        };
  const remembered = await database
    .select({
      customerId: sql<string | null>`${schema.auditLog.after}->>'stripeCustomerId'`,
      subscriptionId: sql<string | null>`${schema.auditLog.after}->>'subscriptionId'`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        inArray(schema.auditLog.actionTaken, [...CUSTOMER_MEMORY_VERBS, 'billing_refund_ready']),
      ),
    );
  const present = (id: string | null | undefined): id is string =>
    typeof id === 'string' && id.length > 0;
  const customerIds = [
    ...new Set([family?.customerId, ...remembered.map((row) => row.customerId)].filter(present)),
  ];
  // A refund-ready purchase stores no customer id, and search may not have indexed it yet.
  const subscriptionIds = [
    ...new Set(
      [family?.subscriptionId, ...remembered.map((row) => row.subscriptionId)].filter(present),
    ),
  ];

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
