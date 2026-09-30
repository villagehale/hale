import type { PlanTier } from './entitlements.js';

/**
 * Per-child fairness metering — the pricing "valve" (spec §1.5, §1.2 pricing).
 *
 * Pricing is family-level (Free / Plus $9 / Family $19 CAD); it does NOT scale
 * with children. The fairness valve scales a monthly LLM-COST ALLOWANCE by child
 * count so a big family isn't unfairly throttled, and nudges/holds autonomy once
 * a family blows past it. The cost driver is event volume × autonomy, NOT child
 * age — so the allowance is a function of (plan_tier, childCount) only, never of
 * any per-event child attribution (events aren't reliably child-scoped).
 *
 * UNIT IS USD. The valve compares against summed `agent_runs.cost_usd`, which is
 * what `estimateCostUsd` records (Anthropic bills USD). The $9/$19 plan prices
 * are CAD revenue; these allowances are the USD cost (COGS) ceiling.
 *
 * BASIS for the numbers (spec §1.5 "≤ $5 / family / month at steady state"):
 *   - PAID base = $5.00 — the spec's stated 1-child steady-state target exactly.
 *     The allowance is a COGS *ceiling* (a spend guardrail), independent of the
 *     $9/$19 CAD display price — not a margin guarantee.
 *   - PER-ADDITIONAL-CHILD = $3.00 — a marginal child adds roughly proportional
 *     event volume, but shared family overhead (one daily digest, one nightly
 *     memory-inference batch, a shared system-prompt cache) is NOT re-paid per
 *     child, so the increment is ~60% of base, not a full $5.
 *   - FREE base = $2.00, free increment = $1.50 — Free never auto-executes (it is
 *     observe/draft only), so the valve's autonomy throttle is moot for it; the
 *     lower ceiling exists only so the over-allowance nudge can fire and surface
 *     an upgrade hint when a free family's passive cost runs hot.
 */
interface TierAllowance {
  /** Monthly USD allowance for the first child. */
  baseUsd: number;
  /** Additional monthly USD allowance per child beyond the first. */
  perAdditionalChildUsd: number;
}

const TIER_ALLOWANCE = {
  free: { baseUsd: 2.0, perAdditionalChildUsd: 1.5 },
  plus: { baseUsd: 5.0, perAdditionalChildUsd: 3.0 },
  family: { baseUsd: 5.0, perAdditionalChildUsd: 3.0 },
} as const satisfies Record<PlanTier, TierAllowance>;

/**
 * The monthly LLM-cost allowance (USD) for a family on `planTier` with
 * `childCount` children. A childless family (count 0) and a single-child family
 * (count 1) both get exactly the base — there is no per-additional-child credit
 * below the first child, so the increment applies only to children 2..N.
 * Negative counts are clamped to 0 additional children. Pure — no I/O.
 */
export function monthlyAllowanceUsd(planTier: PlanTier, childCount: number): number {
  const tier = TIER_ALLOWANCE[planTier];
  const additionalChildren = Math.max(0, childCount - 1);
  return tier.baseUsd + additionalChildren * tier.perAdditionalChildUsd;
}

/**
 * True iff a family's month-to-date LLM spend has passed its allowance. The
 * boundary is OVER, not at: spend exactly equal to the allowance is still within
 * (a family that has used precisely its budget is not yet throttled). Pure — no I/O.
 */
export function isOverAllowance(
  spentUsd: number,
  planTier: PlanTier,
  childCount: number,
): boolean {
  return spentUsd > monthlyAllowanceUsd(planTier, childCount);
}

/**
 * How far over the soft allowance a family must be before the HARD ceiling trips
 * (3× — well clear of the soft over-allowance valve's own trip point, so a normal
 * over-allowance family keeps getting drafts instead of being cut off cold). The
 * single source for both the trip check and the ceiling value written to audits.
 */
export const HARD_CEILING_MULTIPLIER = 3;

/** The HARD ceiling in USD for a family (allowance × the multiplier). Pure. */
export function hardCeilingUsd(planTier: PlanTier, childCount: number): number {
  return monthlyAllowanceUsd(planTier, childCount) * HARD_CEILING_MULTIPLIER;
}

/**
 * The distinct HARD ceiling — a runaway breaker, NOT the soft autonomy valve.
 * `isOverAllowance` throttles AUTONOMY (holds actions for approval) after the LLM
 * stages have already spent. This predicate is the ceiling itself: spend strictly
 * over allowance × multiplier. Whether a caller drops the event or only warns is
 * {@link spendCeilingEnforced} — paid tiers are not launched, so the default is
 * to keep going. The `multiplier` defaults to HARD_CEILING_MULTIPLIER. Boundary
 * is OVER, not at. Pure — no I/O.
 */
export function isOverHardCeiling(
  spentUsd: number,
  planTier: PlanTier,
  childCount: number,
  multiplier = HARD_CEILING_MULTIPLIER,
): boolean {
  return spentUsd > monthlyAllowanceUsd(planTier, childCount) * multiplier;
}

/** Env flag. Literal `true` enforces the hard ceiling (drop before classify).
 * Anything else — unset, `false`, `1`, a trailing newline from `echo` — leaves
 * enforcement off. Paid tiers are not launched; a mis-set value must not resume
 * dropping a family's events or chat. Set it with `printf '%s'`. */
export const SPEND_CEILING_ENFORCED_ENV = 'SPEND_CEILING_ENFORCED';

export function spendCeilingEnforced(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SPEND_CEILING_ENFORCED_ENV] === 'true';
}

/** UTC day key for the once-per-family warn audit. */
export function spendCeilingDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Ops page for a family over the ceiling while enforcement is off. Opaque family
 * id and the dollar figures only — no name, no message, no child. The audit row
 * is `spend_ceiling_exceeded_warn`.
 */
export function spendCeilingWarnText(input: {
  familyId: string;
  planTier: string;
  childCount: number;
  monthToDateCostUsd: number;
  ceilingUsd: number;
  day: string;
}): string {
  const spent = input.monthToDateCostUsd.toFixed(2);
  const ceiling = input.ceilingUsd.toFixed(2);
  return `Hale ops: family ${input.familyId} is over its monthly LLM-cost ceiling ($${spent} of $${ceiling}, plan ${input.planTier}, ${input.childCount} children, ${input.day}). Enforcement is off, so ingest and chat continue. Audit verb spend_ceiling_exceeded_warn.`;
}
