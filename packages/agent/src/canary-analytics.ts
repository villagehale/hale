/**
 * The PostHog tag for the inbound canary household (VIL-764).
 *
 * One property, boolean true, on the event and (when the distinct id is that
 * household) on the person via `$set`. PostHog's "filter out internal and test
 * users" list describes traffic to KEEP, so the project filter is `canary` is
 * not `true` — both as a person property and as an event property.
 *
 * The decision is not made here. Callers pass `isCanary` from the probe's
 * identity (the configured number's household). Message text is not an input.
 */

export const CANARY_ANALYTICS_PROPERTY = 'canary';

/** Distinct ids shared by every request on a route. A person property on one of
 * these would mark traffic that is not the probe. */
function sharedDistinctId(distinctId: string): boolean {
  return (
    distinctId === 'system' || distinctId.startsWith('door:') || distinctId.startsWith('lane:')
  );
}

export function canaryCaptureExtras(
  isCanary: boolean,
  distinctId: string,
): { event: { canary: true } | Record<string, never>; set: { canary: true } | null } {
  if (!isCanary) return { event: {}, set: null };
  return {
    event: { canary: true },
    set: sharedDistinctId(distinctId) ? null : { canary: true },
  };
}
