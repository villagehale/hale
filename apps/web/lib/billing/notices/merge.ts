import type { BillingNoticeEventFacts } from '@hale/db';

type NoticeRefund = NonNullable<BillingNoticeEventFacts['refunds']>[number];

/**
 * VIL-735 · one notice's facts from two events, whichever arrived first: every ended
 * subscription stays named, refunds merge per charge at the highest total Stripe has
 * reported, and event ids are unioned. Two different subscriptions in the payment lane
 * are not one purchase, so the merge says so instead of keeping whichever came first.
 */
export function mergeNoticeFacts(
  a: BillingNoticeEventFacts,
  b: BillingNoticeEventFacts,
): BillingNoticeEventFacts {
  const merged: BillingNoticeEventFacts = {
    eventIds: [...new Set([...a.eventIds, ...b.eventIds])],
  };
  const sessionCreatedAt = a.sessionCreatedAt ?? b.sessionCreatedAt;
  if (sessionCreatedAt !== undefined) merged.sessionCreatedAt = sessionCreatedAt;
  const sessionTier = a.sessionTier ?? b.sessionTier;
  if (sessionTier !== undefined) merged.sessionTier = sessionTier;
  const subscriptionId = a.subscriptionId ?? b.subscriptionId;
  if (subscriptionId !== undefined) merged.subscriptionId = subscriptionId;
  if (
    a.conflictingPayment ||
    b.conflictingPayment ||
    (a.subscriptionId !== undefined &&
      b.subscriptionId !== undefined &&
      a.subscriptionId !== b.subscriptionId)
  ) {
    merged.conflictingPayment = true;
  }
  Object.assign(merged, mergeEnded(a, b));
  const refunds = mergeRefunds(a.refunds ?? [], b.refunds ?? []);
  if (refunds.length > 0) merged.refunds = refunds;
  return merged;
}

/** Every subscription this notice says ended. */
export function endedSubscriptionIds(facts: BillingNoticeEventFacts): string[] {
  return facts.ended ? [facts.ended.subscriptionId, ...(facts.alsoEnded ?? [])] : [];
}

/** Two subscriptions that ended for different reasons have no one reason to state. */
function mergeEnded(
  a: BillingNoticeEventFacts,
  b: BillingNoticeEventFacts,
): Pick<BillingNoticeEventFacts, 'ended' | 'alsoEnded'> {
  const first = a.ended ?? b.ended;
  if (!first) return {};
  const alsoEnded = [
    ...new Set([...endedSubscriptionIds(a), ...endedSubscriptionIds(b)]),
  ].filter((id) => id !== first.subscriptionId);
  const reasonsDiffer =
    a.ended !== undefined &&
    b.ended !== undefined &&
    a.ended.subscriptionId !== b.ended.subscriptionId &&
    a.ended.why !== b.ended.why;
  return {
    ended: reasonsDiffer ? { ...first, why: null } : first,
    ...(alsoEnded.length > 0 ? { alsoEnded } : {}),
  };
}

function mergeRefunds(a: readonly NoticeRefund[], b: readonly NoticeRefund[]): NoticeRefund[] {
  const byCharge = new Map<string, NoticeRefund>();
  for (const refund of [...a, ...b]) {
    const seen = byCharge.get(refund.chargeId);
    if (!seen) {
      byCharge.set(refund.chargeId, refund);
      continue;
    }
    const higher = refund.refundedMinor > seen.refundedMinor ? refund : seen;
    const subscriptionId = seen.subscriptionId ?? refund.subscriptionId;
    byCharge.set(
      refund.chargeId,
      subscriptionId === undefined ? higher : { ...higher, subscriptionId },
    );
  }
  return [...byCharge.values()];
}

/** True when `incoming` names a charge or an ended subscription `existing` does not. */
export function addsNoticeSubject(
  existing: BillingNoticeEventFacts,
  incoming: BillingNoticeEventFacts,
): boolean {
  const endedKnown = new Set(endedSubscriptionIds(existing));
  if (endedSubscriptionIds(incoming).some((id) => !endedKnown.has(id))) return true;
  const known = new Set((existing.refunds ?? []).map((refund) => refund.chargeId));
  return (incoming.refunds ?? []).some((refund) => !known.has(refund.chargeId));
}
