/** The outbound discriminator for a next-day check-back. Not the VIL-419 follow-up key. */
export const NEXT_DAY_CHECKBACK_TEMPLATE_KEY = 'next-day-checkback';

/** One check-back per workstream, ever: the candidate and the ledger row share this key. */
export function nextDayCheckbackDedupeKey(workstreamId: string): string {
  return `${NEXT_DAY_CHECKBACK_TEMPLATE_KEY}:${workstreamId}`;
}
