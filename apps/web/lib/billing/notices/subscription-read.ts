import { stripeGet } from '~/lib/billing/stripe-charge-context';

/** What the notice needs from Stripe about one subscription. */
export interface NoticeSubscription {
  status: string | null;
  createdAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface NoticeSubscriptionReader {
  read(subscriptionId: string): Promise<NoticeSubscription>;
}

/**
 * VIL-735 · a read-only GET of one subscription. A thrown failure is the caller's failed
 * attempt. Since API version `2025-03-31.basil` the period end lives on the item and was
 * removed from the subscription, so the item's value is read first.
 */
export function stripeSubscriptionReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): NoticeSubscriptionReader | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return null;
  return {
    async read(subscriptionId) {
      const row = await stripeGet(
        secret,
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        fetchImpl,
      );
      return readNoticeSubscription(row);
    },
  };
}

export function readNoticeSubscription(row: Record<string, unknown>): NoticeSubscription {
  const items = isRecord(row.items) && Array.isArray(row.items.data) ? row.items.data : [];
  const item = items.find(isRecord);
  const periodEnd = instant(item?.current_period_end) ?? instant(row.current_period_end);
  return {
    status: typeof row.status === 'string' ? row.status.toLowerCase() : null,
    createdAt: instant(row.created),
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
  };
}

function instant(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value * 1000)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
