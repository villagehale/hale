/**
 * Plan/billing is family-level (state.md: per-stage plans REJECTED — stages
 * coexist in one family). Autonomous execute stays ungated by plan (VIL-131):
 * a family's plan never decides whether an approved, opted-in action runs.
 *
 * `family` is the Max plan in Stripe/UI. A Max purchase writes `family`.
 *
 * MAX_ENTITLEMENTS_ENABLED (default off): Max unlocks exactly what Plus does —
 * today's behavior. When the flag is on, Max is the only tier that gets higher
 * search and watch limits, priority support, and Browser Use signup help.
 *
 * Plus vs Max when the flag is on (Free matches Plus):
 *
 * | | Plus / Free | Max (`family`) | Flag off (every tier) |
 * | activity web searches per `find_activities` call | 3 | 8 | 3 |
 * | `find_activities` calls per inbound turn | 2 | 4 | 2 |
 * | concurrent live watches (`watched_spots` + `family_watch_subscriptions`) | 8 | 20 | uncapped (`null`) |
 * | `signup_help` (Browser Use registration) | 2 per registration season | unlimited | not gated by plan |
 * | `priority_support` | no | yes | no |
 *
 * A registration season is winter (Oct 1–Jan 31), spring (Feb–Mar), summer
 * (Apr–Jun) or fall (Jul–Sep) in the family's timezone — the windows city rec
 * typically opens, not calendar quarters. Connector / Playwright authorized
 * signup stays on every tier. Medical, off-domain, and intake search budgets
 * are not in this table.
 *
 * Limit-hit replies are model-composed from these numbers. No parent-visible
 * plan name, upgrade prompt, or template copy.
 */
export type PlanTier = 'free' | 'plus' | 'family';

/** The two billing periods the dormant checkout seam accepts. */
export type BillingPeriod = 'monthly' | 'annual';

/**
 * What a family may spend on search, watches, signup help, and ops priority.
 * `liveWatches: null` means no per-family cap (today, flag off).
 */
export interface FamilyEntitlements {
  /** Web searches one `find_activities` call may spend. */
  activitySearchesPerCall: number;
  /** `find_activities` calls one inbound turn may make. */
  activityCallsPerTurn: number;
  /** Concurrent live watches; `null` means no family cap. */
  liveWatches: number | null;
  /**
   * Browser Use registration attempts allowed per registration season.
   * `null` means unlimited (Max, and every tier while the flag is off).
   * Plus and Free: 2. `BROWSER_USE_SIGNUP_ENABLED` remains the engine gate.
   */
  signupHelpPerSeason: number | null;
  /** Max families sort first in ops and are marked on the daily #ops post. */
  prioritySupport: boolean;
}

/** Today's behavior: every paid (and free) family, flag off. */
export const TODAY_ENTITLEMENTS: FamilyEntitlements = {
  activitySearchesPerCall: 3,
  activityCallsPerTurn: 2,
  liveWatches: null,
  signupHelpPerSeason: null,
  prioritySupport: false,
};

/** Plus and Free when MAX_ENTITLEMENTS_ENABLED is on. */
export const PLUS_ENTITLEMENTS: FamilyEntitlements = {
  activitySearchesPerCall: 3,
  activityCallsPerTurn: 2,
  liveWatches: 8,
  signupHelpPerSeason: 2,
  prioritySupport: false,
};

/** Max (`family`) when MAX_ENTITLEMENTS_ENABLED is on. */
export const MAX_ENTITLEMENTS: FamilyEntitlements = {
  activitySearchesPerCall: 8,
  activityCallsPerTurn: 4,
  liveWatches: 20,
  signupHelpPerSeason: null,
  prioritySupport: true,
};

export function entitlementsFor(
  tier: PlanTier,
  maxEntitlementsEnabled: boolean,
): FamilyEntitlements {
  if (!maxEntitlementsEnabled) return TODAY_ENTITLEMENTS;
  return tier === 'family' ? MAX_ENTITLEMENTS : PLUS_ENTITLEMENTS;
}

/**
 * Sort key for ops queues: Max (`prioritySupport`) first, then older items.
 * Returns negative when `a` should be listed before `b`.
 */
export function compareOpsPriority(
  a: { prioritySupport: boolean; atMs: number },
  b: { prioritySupport: boolean; atMs: number },
): number {
  if (a.prioritySupport !== b.prioritySupport) return a.prioritySupport ? -1 : 1;
  return a.atMs - b.atMs;
}
