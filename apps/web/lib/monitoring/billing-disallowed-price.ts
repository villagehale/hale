import { postOpsSlack } from './ops-slack.js';

export interface DisallowedPriceAlert {
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly priceIds: readonly string[];
  readonly reason: string;
}

/**
 * Short #ops text for a paid session whose price is not in the promo allowed
 * set. Event / session / price ids only — no family, email, or other PII.
 */
export function composeDisallowedPriceAlert(input: DisallowedPriceAlert): string {
  const prices = input.priceIds.length > 0 ? input.priceIds.join(',') : 'none';
  const session = input.sessionId ?? 'none';
  return `billing: paid Stripe session used a disallowed price. event=${input.eventId} session=${session} prices=${prices} reason=${input.reason}. plan_tier not granted. refund-ready; do not auto-refund.`;
}

export async function alertDisallowedCheckoutPrice(
  input: DisallowedPriceAlert,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  console.warn('stripe billing: disallowed price on paid session', {
    eventId: input.eventId,
    sessionId: input.sessionId,
    priceIds: input.priceIds,
    reason: input.reason,
  });
  await postOpsSlack(composeDisallowedPriceAlert(input), fetchImpl);
}
