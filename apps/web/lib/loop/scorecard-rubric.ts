import type { IntakeFunnel, LlmCogs, TtfaStat } from './funnel-scoreboard';

/**
 * THE FOUNDER SCORECARD'S RUBRIC — eight graded rows, and every threshold that
 * produces them, in one auditable file.
 *
 * A dashboard hands a founder counts and lets them decide, every Monday, whether
 * this week's numbers are good. A scorecard decides that ONCE and in the open. The
 * whole value is that the deciding happens here, in constants with reasons attached,
 * rather than in the reader's mood — so a week that scores 6 scores 6 because a
 * written band says so, and a week that scores worse than last week says which band
 * it fell out of.
 *
 * THREE RULES HOLD THIS HONEST, and each one is a way a scorecard normally rots:
 *
 *   1. THE THRESHOLDS ARE DATA, NOT PROSE. Every band below is a named constant with
 *      the reasoning beside it. Regrading the product means editing a number a code
 *      review can see, and the tests derive their expected scores from these same
 *      constants, so a moved threshold breaks a test instead of flattering a week.
 *
 *   2. A MISSING INPUT SCORES `null`, NEVER 0. `–/10 · not enough data (n=X)` and
 *      `0/10` are opposite claims — one says we cannot see, the other says we looked
 *      and it is bad — and a scorecard that renders them the same is worse than no
 *      scorecard, because it manufactures alarm out of an unwired metric.
 *
 *   3. A ZERO THAT WAS MEASURED IS GRADED. The mirror of rule 2, and the more
 *      tempting failure: no source-coded intake in a week the intake flow ran is a
 *      0, not a shrug. Rows only decline to grade when their DENOMINATOR is absent.
 *
 * Pure by construction: no DB, no clock, no environment. Each grader takes the
 * narrowest shape that answers its question — the deliverability grader can only see
 * direction/status/count, so it cannot start reading categories — and the aggregation
 * that feeds them lives in health-digest.ts / funnel-scoreboard.ts.
 */

export interface ScorecardRow {
  label: string;
  /** `null` means this week's data could not grade the row. NEVER a zero standing in
   * for "unknown" — see rule 2 in the module header. */
  score: number | null;
  reason: string;
}

/** A grading band: reach (or stay under) `bound` and the row earns `score`. Bands are
 * written best-first and read top-down, so the first one a measure satisfies wins. */
interface Band {
  readonly bound: number;
  readonly score: number;
}

/** Bands for a measure where MORE is better. Below every band is 0. */
function scoreAtLeast(measure: number, bands: readonly Band[]): number {
  return bands.find((band) => measure >= band.bound)?.score ?? 0;
}

/** Bands for a measure where LESS is better. Above every band is 0. */
function scoreAtMost(measure: number, bands: readonly Band[]): number {
  return bands.find((band) => measure <= band.bound)?.score ?? 0;
}

/** The one wording for an ungradeable row, so `–/10` always reads the same and the
 * missing denominator is always stated. */
function notEnoughData(n: number, why?: string): string {
  return why ? `not enough data (n=${n}) - ${why}` : `not enough data (n=${n})`;
}

function percent(n: number, base: number): string {
  return `${Math.round((n / base) * 100)}%`;
}

// ── 1 · Demand ───────────────────────────────────────────────────────────────

/**
 * Source-coded intakes Hale wants in a week, and the ONLY number the demand row is
 * graded against.
 *
 * Ten, because the QR venue code is the single field that says where a family came
 * from, and ten a week is the volume at which one venue's conversion starts being
 * readable against another's instead of being noise. It is a target, not a forecast:
 * raising it because a week looked bad is exactly the edit this constant exists to
 * make visible.
 */
export const DEMAND_WEEKLY_TARGET_SOURCE_CODED = 10;

/** Fractions of the weekly target. */
const DEMAND_BANDS: readonly Band[] = [
  // At or over target — the probes are producing the volume the launch plan assumes.
  { bound: 1.0, score: 10 },
  // A good week that missed: within 30% of target.
  { bound: 0.7, score: 8 },
  // Real but thin — enough to compare two venues, not enough to trust either.
  { bound: 0.4, score: 6 },
  // A trickle. One venue working and the rest silent looks like this.
  { bound: 0.2, score: 4 },
  // Anything attributable at all beats nothing: the channel is at least alive.
  { bound: 0, score: 2 },
];

export function gradeDemand(
  intake: Pick<IntakeFunnel, 'sourceCoded' | 'sessionsStarted'>,
): ScorecardRow {
  const { sourceCoded, sessionsStarted } = intake;
  // Both of these are 0 against the target, and they are different problems: no
  // traffic at all is a distribution failure, traffic with no code on it is a probe
  // failure. The grade is the same; the sentence a founder acts on is not.
  if (sourceCoded === 0) {
    const shortfall =
      sessionsStarted === 0
        ? 'no intake started at all'
        : `${sessionsStarted} started, none attributable`;
    return {
      label: 'Demand',
      score: 0,
      reason: `no source-coded intake of a ${DEMAND_WEEKLY_TARGET_SOURCE_CODED}/wk target (${shortfall})`,
    };
  }
  return {
    label: 'Demand',
    score: scoreAtLeast(sourceCoded / DEMAND_WEEKLY_TARGET_SOURCE_CODED, DEMAND_BANDS),
    reason: `${sourceCoded} of ${DEMAND_WEEKLY_TARGET_SOURCE_CODED} target source-coded intakes (${sessionsStarted} started)`,
  };
}

// ── 2 · Activation ───────────────────────────────────────────────────────────

/** TTFA p50 ceilings, in seconds. */
const TTFA_BANDS: readonly Band[] = [
  // Under a minute: the radar lands while the parent is still holding the phone. This
  // is the promise the product is actually making, so it is the only 10.
  { bound: 60, score: 10 },
  // Under three minutes: they have put the phone down and not yet moved on.
  { bound: 180, score: 8 },
  // Under ten minutes: late enough to be noticed, early enough to still be the answer.
  { bound: 600, score: 6 },
  // Under half an hour: the exchange is broken, but the answer did arrive.
  { bound: 1800, score: 3 },
];

/** Share of started intake conversations that became a family. */
const PROVISIONED_BANDS: readonly Band[] = [
  // Four in five conversations provision — the flow is not the thing losing people.
  { bound: 0.8, score: 10 },
  { bound: 0.6, score: 8 },
  // Below three in five the intake itself is the leak, not the traffic.
  { bound: 0.4, score: 6 },
  { bound: 0.2, score: 3 },
];

export interface ActivationInput extends Pick<TtfaStat, 'p50Seconds'> {
  provisioned: number;
  sessionsStarted: number;
}

/**
 * Activation is two questions with one answer: how fast the first radar reply landed,
 * and how many conversations survived to a family. The row takes the WORSE of the two
 * — a scorecard whose halves average out is a dashboard again, and a sub-minute reply
 * to a funnel that loses half its parents is not a good week.
 */
export function gradeActivation(input: ActivationInput): ScorecardRow {
  const { p50Seconds, provisioned, sessionsStarted } = input;
  const label = 'Activation';
  if (sessionsStarted === 0) {
    return { label, score: null, reason: notEnoughData(0) };
  }

  const provisionedScore = scoreAtLeast(provisioned / sessionsStarted, PROVISIONED_BANDS);
  const provisionedText = `${provisioned} of ${sessionsStarted} provisioned (${percent(provisioned, sessionsStarted)})`;

  // A p50 nobody could derive is not a slow p50 — grading it as one would invent a
  // failure out of an unmeasurable exchange. The half we do have still grades.
  if (p50Seconds === null) {
    return { label, score: provisionedScore, reason: `TTFA not derivable · ${provisionedText}` };
  }

  const ttfaScore = scoreAtMost(p50Seconds, TTFA_BANDS);
  return {
    label,
    score: Math.min(ttfaScore, provisionedScore),
    reason: `TTFA p50 ${p50Seconds}s · ${provisionedText}`,
  };
}

// ── 3 · Engagement ───────────────────────────────────────────────────────────

/** Share of families Hale started at least one conversation with this week. */
const ENGAGEMENT_BANDS: readonly Band[] = [
  // Nine in ten heard from Hale unprompted — the quiet operator is operating.
  { bound: 0.9, score: 10 },
  { bound: 0.75, score: 8 },
  // Half the households got nothing all week: the loop is running for a subset.
  { bound: 0.5, score: 6 },
  { bound: 0.25, score: 3 },
];

export interface FamilyEngagement {
  /** Families that existed for the WHOLE window — the only ones that had a full week
   * in which to be contacted. A family that signed up on Saturday is not evidence of
   * a quiet loop, and counting it as one would make growth look like decay. */
  families: number;
  /** Of those, the ones Hale made contact with first (see HALE_INITIATED_CATEGORIES). */
  contacted: number;
}

export function gradeEngagement(engagement: FamilyEngagement): ScorecardRow {
  const { families, contacted } = engagement;
  const label = 'Engagement';
  if (families === 0) {
    return { label, score: null, reason: notEnoughData(0) };
  }
  return {
    label,
    score: scoreAtLeast(contacted / families, ENGAGEMENT_BANDS),
    reason: `${contacted} of ${families} families heard from Hale first (${percent(contacted, families)})`,
  };
}

// ── 4 · W4 retention ─────────────────────────────────────────────────────────

/**
 * THE NORTH STAR, as a fraction: the F14 Build Plan's scoreboard declares W2 >= 40%.
 *
 * It is stated here rather than re-derived because it is the one retention number the
 * plan actually committed to, and the D15 monetization trigger reads it too (">= 25
 * watch-enrolled + W2 >= 40% twice"). Every band below is a multiple of it, so raising
 * or lowering the product's ambition is a single edit a code review can see.
 */
export const RETENTION_W2_TARGET = 0.4;

/** The week whose retention the scorecard grades. A month in is the first point at
 * which "came back" has stopped meaning "has not left yet". */
export const RETENTION_GRADED_WEEK = 4;

/** Fractions of {@link RETENTION_W2_TARGET}, measured at week 4. */
const RETENTION_BANDS: readonly Band[] = [
  // A month in and still at the week-2 north star: the curve went flat, which is the
  // only shape that means the product became part of the week.
  { bound: 1.0, score: 10 },
  // Three quarters of it. Normal decay for something parents genuinely use.
  { bound: 0.75, score: 8 },
  // Half. Real usage that is still leaking.
  { bound: 0.5, score: 6 },
  // A quarter — a handful of households, and no habit.
  { bound: 0.25, score: 3 },
];

/**
 * One cell of the retention grid: of the families that signed up in `signupWeek` and
 * have had week `weekN` FULLY elapse, how many texted Hale back during it.
 *
 * `cohortSize` counts only the families for which the week is OBSERVABLE. A week that
 * has not finished yet is absent from the grid entirely rather than present as a zero —
 * "nobody came back" and "we cannot know yet" are the rule-2 pair, and a cohort that
 * signed up on Friday would otherwise drag every recent week toward 0%.
 */
export interface RetentionCohort {
  /** Monday-aligned signup week in the founder's zone, as `YYYY-MM-DD`. */
  signupWeek: string;
  /** Whole weeks since the family was provisioned, 1-based. */
  weekN: number;
  cohortSize: number;
  retained: number;
}

/**
 * W4 retention — of the families old enough to have had a fourth week, how many texted
 * Hale during it.
 *
 * THIS ROW REPLACED "opened the app on 3+ days in 14". The pivot demoted the web app to
 * a receipts room (D4/D20), so an app-open stopped being evidence of anything: the
 * product is a number you text, and the only honest proof a family is still using it is
 * that they sent it a message. It sits directly after Engagement because the two are
 * one question asked from both ends — engagement is whether Hale reached them, this is
 * whether they came back.
 *
 * Pooled across cohorts rather than reported per signup week: the grade is one number,
 * and a five-family cohort's 0% is noise next to the whole population's rate.
 */
export function gradeW4Retention(cohorts: readonly RetentionCohort[]): ScorecardRow {
  const label = 'W4 retention';
  const graded = cohorts.filter((cohort) => cohort.weekN === RETENTION_GRADED_WEEK);
  const cohortSize = graded.reduce((sum, cohort) => sum + cohort.cohortSize, 0);
  // An empty cohort is not a 0% cohort. Before any family has had five weeks elapse
  // there is nothing to grade, and scoring that 0 would report a young product as a
  // failed one (rule 2).
  if (cohortSize === 0) {
    return {
      label,
      score: null,
      reason: notEnoughData(0, `no cohort has finished week ${RETENTION_GRADED_WEEK} yet`),
    };
  }
  const retained = graded.reduce((sum, cohort) => sum + cohort.retained, 0);
  return {
    label,
    score: scoreAtLeast(retained / cohortSize / RETENTION_W2_TARGET, RETENTION_BANDS),
    reason: `${retained} of ${cohortSize} families texted back in week ${RETENTION_GRADED_WEEK} (${percent(retained, cohortSize)}) · north star is W2 ${Math.round(RETENTION_W2_TARGET * 100)}%`,
  };
}

// ── 5 · Radar accuracy ───────────────────────────────────────────────────────

/** Share of due registration windows the weekly sweep re-confirmed against source. */
const RADAR_BANDS: readonly Band[] = [
  // Effectively everything held. A wrong registration time is the one error this
  // radar cannot make, so the top band is deliberately unforgiving.
  { bound: 0.95, score: 10 },
  { bound: 0.85, score: 8 },
  // Three in ten rows unconfirmed is a dataset a family should not be woken by.
  { bound: 0.7, score: 6 },
  { bound: 0.5, score: 3 },
];

/**
 * The tally ONE re-verify run left behind — its own count of what it did, written by the
 * sweep at the end of the run rather than inferred afterwards from the rows it touched.
 *
 * Inference was the previous reading and it could not tell the two failures apart: a
 * confirmation bumps `verified_at` while BOTH a moved date and an unreadable page
 * deliberately write nothing (the sweep's honesty design — a stale row is the signal).
 * Every row is exactly one of the three, so `confirmed + discrepancies + unverified`
 * is `checked`.
 */
export interface VerifyRunOutcomes {
  /** Upcoming windows this run actually attempted — its own per-run ceiling, not the
   * size of the dataset. */
  checked: number;
  /** Re-read and still saying what we store. */
  confirmed: number;
  /** The page no longer says what we store. A seed to fix by hand. */
  discrepancies: number;
  /** Could not be verified at all — fetch failed, cycle gone, reading uncorroborated. */
  unverified: number;
}

export interface RadarVerification {
  /** Whether a re-verify sweep week overlapped this digest window at all. */
  sweptThisWeek: boolean;
  /** What that sweep recorded, or null when a claimed week left no tally — it died
   * mid-run, or it ran before the outcome ledger existed. Not the same news as a sweep
   * that never started, and graded as neither. */
  outcomes: VerifyRunOutcomes | null;
}

/**
 * Radar accuracy — how much of the dataset a family could still act on was re-read
 * against the municipality's own page this week, graded on the SWEEP'S OWN TALLY.
 *
 * The two ways a row goes unconfirmed are separate numbers here because they are
 * separate jobs: a moved date is a seed to correct today, an unreadable page is a
 * scraper to fix, and the single "left stale" count this row used to print made the
 * founder guess which week they were having.
 */
export function gradeRadarAccuracy(radar: RadarVerification): ScorecardRow {
  const { sweptThisWeek, outcomes } = radar;
  const label = 'Radar accuracy';
  // A sweep that never ran got nothing wrong. Scoring that 0 would report a missing
  // cron as a wrong dataset — two problems that need two different Mondays.
  if (!sweptThisWeek) {
    return { label, score: null, reason: notEnoughData(0, 'the re-verify sweep did not run') };
  }
  if (!outcomes) {
    return { label, score: null, reason: notEnoughData(0, 'the sweep recorded no outcomes') };
  }
  const { checked, confirmed, discrepancies, unverified } = outcomes;
  if (checked === 0) {
    return { label, score: null, reason: notEnoughData(0) };
  }

  const score = scoreAtLeast(confirmed / checked, RADAR_BANDS);
  const reason =
    confirmed === checked
      ? `all ${checked} due windows re-confirmed at source`
      : `${confirmed} of ${checked} due windows re-confirmed · ${discrepancies} moved dates, ${unverified} could not be read`;
  return { label, score, reason };
}

// ── 6 · Deliverability ───────────────────────────────────────────────────────

/** Share of outbound legs that reached a family. */
const DELIVERABILITY_BANDS: readonly Band[] = [
  // At most one leg in a hundred missed. Messaging IS the product surface, so this
  // row is graded like a transport, not like a feature.
  { bound: 0.99, score: 10 },
  { bound: 0.97, score: 8 },
  { bound: 0.95, score: 6 },
  { bound: 0.9, score: 3 },
];

/** Statuses that mean the leg left Hale for the carrier. Everything that is neither
 * this nor still in flight is a message the family did not get — stated as the
 * COMPLEMENT so a status added to the enum later lands on the honest side by default
 * rather than silently dropping out of the denominator. */
const REACHED_STATUSES: ReadonlySet<string> = new Set(['sent', 'delivered']);

/** Not an outcome yet. A queued row is the drain's latency, not a delivery failure,
 * so it is excluded from BOTH sides rather than counted as a miss. */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['queued']);

/** The one status that means the send itself broke. Every other not-reached status is
 * a suppression — Hale deciding not to send — and the reason line keeps the two
 * apart, because they are the same ratio and completely different news. */
const FAILED_STATUS = 'failed';

export interface DeliveryCount {
  direction: string;
  status: string;
  count: number;
}

/**
 * Deliverability counts OUTBOUND legs only. Inbound rows are written `delivered` —
 * one per text a parent sends — so letting them into the numerator would make a
 * chatty week score 10/10 through any number of failed sends.
 *
 * Suppressions ARE in the denominator, deliberately: this row measures whether a
 * family got what Hale had for them, not whether Hale was at fault. A week where
 * quiet hours ate a fifth of the sends is a week a fifth of the families heard
 * nothing, and the reason line names the split so the founder can tell which of the
 * two stories they are looking at.
 */
export function gradeDeliverability(counts: readonly DeliveryCount[]): ScorecardRow {
  const label = 'Deliverability';
  const outbound = counts.filter(
    (row) => row.direction === 'out' && !IN_FLIGHT_STATUSES.has(row.status),
  );
  const attempted = outbound.reduce((sum, row) => sum + row.count, 0);
  if (attempted === 0) {
    return { label, score: null, reason: notEnoughData(0) };
  }

  const reached = outbound
    .filter((row) => REACHED_STATUSES.has(row.status))
    .reduce((sum, row) => sum + row.count, 0);
  const failed = outbound
    .filter((row) => row.status === FAILED_STATUS)
    .reduce((sum, row) => sum + row.count, 0);
  const suppressed = attempted - reached - failed;

  return {
    label,
    score: scoreAtLeast(reached / attempted, DELIVERABILITY_BANDS),
    reason: `${percent(reached, attempted)} reached of ${attempted} · ${failed} failed, ${suppressed} suppressed`,
  };
}

// ── 7 · Safety ───────────────────────────────────────────────────────────────

/** Safety-lane deflections in the week. Counts, not a rate: one parent shown a fixed
 * door with a hurt child is a thing to read about, whatever the denominator. */
const SAFETY_BANDS: readonly Band[] = [
  // Nobody brought Hale a safety-critical text it could only answer with a door.
  { bound: 0, score: 10 },
  // A couple. Expected background for a product parents text at 2 a.m.
  { bound: 2, score: 8 },
  // A handful — a real class of question the product does not do yet.
  { bound: 5, score: 6 },
  // Ten in a week is a standing gap, not a trickle.
  { bound: 10, score: 3 },
];

/** The lane whose texts Hale answers with a fixed sentence rather than help. */
const SAFETY_LANE = 'safety_critical';

export interface LaneCount {
  lane: string;
  count: number;
}

/**
 * The medical-symptom lane's week. It does not appear in the lane counts at all —
 * that lane ANSWERS (a web-grounded reply with its own triage) and deliberately writes
 * no unmet-intent row, because a question Hale answered is not an unmet intent — so its
 * outcome is read from the outbound rows it stamped instead.
 */
export interface MedicalAnswers {
  /** Medical-symptom texts Hale answered this week, grounded or not. */
  answered: number;
  /** Of those, the ones that fell back to the fixed 811/911 line because no grounded
   * answer could be composed. */
  fallbacks: number;
}

/**
 * Safety — how often a parent brought Hale something safety-critical and got a fixed
 * door instead of help.
 *
 * A MEDICAL FALLBACK IS ONE OF THOSE DOORS, and now that the lane stamps its outcome on
 * the reply it sent, it is banded as one. It was excluded for exactly as long as it was
 * invisible: the outcome lived in memory as `replySource` and no query could count it,
 * so the row carried a caveat on every grade instead — including its 10s, which is the
 * one grade a safety row must never hand out on trust.
 */
export function gradeSafety(
  lanes: readonly LaneCount[],
  medical: MedicalAnswers,
): ScorecardRow {
  const deflections = lanes
    .filter((row) => row.lane === SAFETY_LANE)
    .reduce((sum, row) => sum + row.count, 0);
  const doors = deflections + medical.fallbacks;
  // "No medical text arrived" and "twelve arrived and all twelve were answered" are the
  // same fallback count and completely different weeks.
  const medicalText =
    medical.answered === 0
      ? 'no medical text arrived'
      : `${medical.fallbacks} of ${medical.answered} medical answers fell back to the fixed line`;
  const doorText =
    doors === 0
      ? 'no safety-lane deflection'
      : `${doors} fixed doors (${deflections} safety-lane deflections, ${medical.fallbacks} medical fallbacks)`;
  return {
    label: 'Safety',
    score: scoreAtMost(doors, SAFETY_BANDS),
    reason: `${doorText} · ${medicalText}`,
  };
}

// ── 8 · Unit cost ────────────────────────────────────────────────────────────

/**
 * The LLM budget line, in USD per family per week. Two dollars is the founder's
 * number: it is what a family's weekly model spend may cost before the unit economics
 * of the free tier stop working, and it is stated here rather than in a spreadsheet so
 * that a week which breaks it breaks a test-covered band.
 */
export const UNIT_COST_BUDGET_USD_PER_FAMILY = 2.0;

/** Multiples of the budget line. */
const UNIT_COST_BANDS: readonly Band[] = [
  // A quarter of budget — the model spend is not the constraint on anything.
  { bound: 0.25, score: 10 },
  { bound: 0.5, score: 9 },
  { bound: 0.75, score: 8 },
  // ON the line is a 6, not a 10: the budget is the edge of viable, not the goal.
  { bound: 1.0, score: 6 },
  // Half again over. Survivable for a week, not a quarter.
  { bound: 1.5, score: 3 },
];

export function gradeUnitCost(cogs: LlmCogs): ScorecardRow {
  const label = 'Unit cost';
  if (cogs.families === 0) {
    return { label, score: null, reason: notEnoughData(0) };
  }
  const perFamily = cogs.totalUsd / cogs.families;
  return {
    label,
    score: scoreAtMost(perFamily / UNIT_COST_BUDGET_USD_PER_FAMILY, UNIT_COST_BANDS),
    reason: `$${perFamily.toFixed(4)} per family vs a $${UNIT_COST_BUDGET_USD_PER_FAMILY.toFixed(2)} budget`,
  };
}
