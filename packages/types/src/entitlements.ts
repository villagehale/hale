import type { ActionType } from './action.js';

/**
 * Plan/billing is family-level (state.md: per-stage plans REJECTED — stages
 * coexist in one family). Tiers gate autonomous EXECUTION only; observe/draft
 * (L1–L2) is free for every stage and child.
 */
export type PlanTier = 'free' | 'plus' | 'family';

/**
 * A capability a paid tier unlocks. `autonomy_l3` is the L3 autonomous-execution
 * unlock; `commerce` and `portal_automation` further gate specific action classes.
 */
export type Entitlement = 'autonomy_l3' | 'commerce' | 'portal_automation';

/**
 * What each tier grants, ratified pricing (state.md, user gate 2026-06-12):
 *   free   — observe/draft only; no autonomous execution.
 *   plus   — L3 autonomy ($24/mo CAD).
 *   family — L3 + commerce action types + portal automation ($49/mo CAD).
 *
 * `satisfies Record<PlanTier, ...>` is load-bearing (mirrors REQUIRED_CHECKS in
 * @hale/tools-contracts): adding a PlanTier without an entry is a COMPILE error,
 * so no tier can ship without an explicit entitlement set.
 */
export const PLAN_ENTITLEMENTS = {
  free: [],
  plus: ['autonomy_l3'],
  family: ['autonomy_l3', 'commerce', 'portal_automation'],
} as const satisfies Record<PlanTier, readonly Entitlement[]>;

/** True iff `tier` grants `entitlement`. Pure — no I/O. */
export function hasEntitlement(tier: PlanTier, entitlement: Entitlement): boolean {
  return (PLAN_ENTITLEMENTS[tier] as readonly Entitlement[]).includes(entitlement);
}

/**
 * The entitlement an action type's autonomous EXECUTION requires beyond base L3,
 * or null when L3 alone suffices.
 *
 *   commerce          — merchant purchase/refund (moves money via Stripe + merchant).
 *   portal_automation — clinic-portal Computer Use (browser-driven actions).
 *   null              — email / calendar / forms / photos / digest: base L3 only.
 *
 * `satisfies Record<ActionType, ...>` keeps this exhaustive against the
 * ActionType union — a new action type without a mapping is a COMPILE error,
 * so no new outward action can ship un-classified for entitlement gating.
 */
const ACTION_ENTITLEMENT = {
  send_email: null,
  reply_to_email: null,
  create_calendar_event: null,
  update_calendar_event: null,
  place_supply_order: 'commerce',
  cancel_supply_order: 'commerce',
  fill_pdf_form: null,
  submit_government_form: null,
  book_clinic_portal: 'portal_automation',
  cancel_clinic_appointment: 'portal_automation',
  share_photos_with_family: null,
  add_to_digest_only: null,
  add_to_routine: null,
} as const satisfies Record<ActionType, Entitlement | null>;

/** The entitlement `actionType` needs beyond base L3, or null. Pure — no I/O. */
export function entitlementRequiredFor(actionType: ActionType): Entitlement | null {
  return ACTION_ENTITLEMENT[actionType];
}
