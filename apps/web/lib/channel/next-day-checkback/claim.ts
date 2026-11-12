/** The outbound discriminator for a next-day check-back. Not the VIL-419 follow-up key. */
export const NEXT_DAY_CHECKBACK_TEMPLATE_KEY = 'next-day-checkback';

/** Every check-back key is this, then the workstream id. The sweep's SQL reads it too. */
export const NEXT_DAY_CHECKBACK_KEY_PREFIX = `${NEXT_DAY_CHECKBACK_TEMPLATE_KEY}:`;

/** One check-back per workstream, ever: the candidate and the ledger row share this key. */
export function nextDayCheckbackDedupeKey(workstreamId: string): string {
  return `${NEXT_DAY_CHECKBACK_KEY_PREFIX}${workstreamId}`;
}
