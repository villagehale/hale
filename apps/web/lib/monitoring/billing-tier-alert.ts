import { type OpsPageOutcome, postOpsSlack } from './ops-slack.js';

/**
 * A refund or dispute the webhook could not tie to a family or to the live
 * subscription. Event id and reason only — no family id.
 */
export async function alertUnresolvedBillingRevoke(
  info: { eventId: string; reason: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OpsPageOutcome> {
  return postOpsSlack(
    `billing: refund or dispute not applied. event=${info.eventId} reason=${info.reason}.`,
    fetchImpl,
  );
}

/** Counts only. The caller already left family ids out of the text. */
export async function alertBillingTierMismatch(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpsPageOutcome> {
  return postOpsSlack(text, fetchImpl);
}
