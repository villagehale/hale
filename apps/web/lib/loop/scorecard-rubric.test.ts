import { describe, expect, it } from 'vitest';
import {
  DEMAND_WEEKLY_TARGET_SOURCE_CODED,
  RETENTION_GRADED_WEEK,
  RETENTION_W2_TARGET,
  type RetentionCohort,
  UNIT_COST_BUDGET_USD_PER_FAMILY,
  gradeActivation,
  gradeDeliverability,
  gradeDemand,
  gradeEngagement,
  gradeRadarAccuracy,
  gradeSafety,
  gradeUnitCost,
  gradeW4Retention,
} from './scorecard-rubric';

/**
 * The founder scorecard's rubric — eight pure graders, each one worked here against a
 * summary whose expected score is DERIVED FROM THE THRESHOLD, not copied from what the
 * code happens to return. Every band boundary below is stated as the arithmetic that
 * lands on it (7 of a 10 target is exactly the 0.7 band), so a moved threshold fails a
 * test instead of quietly regrading the week.
 *
 * The other half of what is tested here is the honesty rule: a row whose INPUT is
 * missing scores `null` and says `not enough data (n=X)`. A row whose input is present
 * and reads zero is GRADED — a zero is a measurement, and turning it into "no data" is
 * the exact flattery this scorecard exists to refuse.
 */

describe('gradeDemand — source-coded intakes against the weekly target', () => {
  it('scores 10 at the target', () => {
    const row = gradeDemand({
      sourceCoded: DEMAND_WEEKLY_TARGET_SOURCE_CODED,
      sessionsStarted: 12,
    });

    expect(row.score).toBe(10);
    expect(row.reason).toContain(`${DEMAND_WEEKLY_TARGET_SOURCE_CODED} target`);
  });

  it('scores 8 at exactly 70% of the target', () => {
    const sourceCoded = DEMAND_WEEKLY_TARGET_SOURCE_CODED * 0.7;

    expect(gradeDemand({ sourceCoded, sessionsStarted: 9 }).score).toBe(8);
  });

  it('scores 4 a third of the way to target — above the 0.2 band, below the 0.4 one', () => {
    const sourceCoded = DEMAND_WEEKLY_TARGET_SOURCE_CODED * 0.3;

    expect(gradeDemand({ sourceCoded, sessionsStarted: 20 }).score).toBe(4);
  });

  /** A week with intakes but no attribution is a real, bad measurement — it means the
   * QR probes are producing nothing — so it is graded 0, never excused as "no data". */
  it('grades an unattributed week 0 rather than calling it missing data', () => {
    const row = gradeDemand({ sourceCoded: 0, sessionsStarted: 11 });

    expect(row.score).toBe(0);
    expect(row.reason).not.toContain('not enough data');
    expect(row.reason).toContain('11 started, none attributable');
  });

  /** Both score 0, and a founder acts on them differently: no traffic is a
   * distribution problem, untagged traffic is a probe problem. */
  it('separates no traffic at all from traffic nothing tagged', () => {
    expect(gradeDemand({ sourceCoded: 0, sessionsStarted: 0 }).reason).toContain(
      'no intake started at all',
    );
  });
});

describe('gradeActivation — TTFA p50 and the provisioning rate, worst half wins', () => {
  it('has nothing to grade when no intake session started', () => {
    const row = gradeActivation({ p50Seconds: 120, provisioned: 0, sessionsStarted: 0 });

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  it('scores 10 for a sub-minute radar reply and 4-in-5 provisioning', () => {
    const row = gradeActivation({ p50Seconds: 45, provisioned: 8, sessionsStarted: 10 });

    expect(row.score).toBe(10);
    expect(row.reason).toContain('45s');
  });

  /** The point of a scorecard: a fast reply must not hide a funnel that leaks. Half the
   * conversations provisioning is the 0.4 band (6), and 6 < the TTFA half's 10. */
  it('takes the WORSE of the two halves and says which one bound it', () => {
    const row = gradeActivation({ p50Seconds: 45, provisioned: 5, sessionsStarted: 10 });

    expect(row.score).toBe(6);
    expect(row.reason).toContain('5 of 10 provisioned');
  });

  it('scores the 180s band at exactly 180 seconds', () => {
    const row = gradeActivation({ p50Seconds: 180, provisioned: 9, sessionsStarted: 10 });

    expect(row.score).toBe(8);
  });

  /** A p50 nobody could derive is not a slow p50. The row still grades the half it has
   * and names the half it does not, rather than scoring the gap as failure. */
  it('grades on provisioning alone when TTFA was not derivable', () => {
    const row = gradeActivation({ p50Seconds: null, provisioned: 9, sessionsStarted: 10 });

    expect(row.score).toBe(10);
    expect(row.reason).toContain('TTFA not derivable');
  });
});

describe('gradeEngagement — families Hale reached out to first', () => {
  it('has nothing to grade before any family has been around a full week', () => {
    const row = gradeEngagement({ families: 0, contacted: 0 });

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  it('scores 10 at 90% reached', () => {
    expect(gradeEngagement({ families: 10, contacted: 9 }).score).toBe(10);
  });

  it('scores 3 at 30% — above the 0.25 band, below the 0.5 one', () => {
    expect(gradeEngagement({ families: 10, contacted: 3 }).score).toBe(3);
  });

  it('grades a silent week 0 over families that exist', () => {
    const row = gradeEngagement({ families: 8, contacted: 0 });

    expect(row.score).toBe(0);
    expect(row.reason).not.toContain('not enough data');
  });
});

describe('gradeW4Retention — families that came back a month in', () => {
  /** A cohort cell, written as the arithmetic that lands on a band rather than as a
   * number copied out of a run. */
  function cohort(weekN: number, cohortSize: number, retained: number): RetentionCohort {
    return { signupWeek: '2026-06-29', weekN, cohortSize, retained };
  }

  /** `retained` for a cohort of `size` sitting exactly on `multiple` × the north star. */
  function retainedAt(multiple: number, size: number): number {
    return RETENTION_W2_TARGET * multiple * size;
  }

  /**
   * Before any cohort has finished its fourth week there is no denominator, so the row
   * abstains. Zero would say the opposite — that a month's worth of families were asked
   * and none came back — out of a product that is three weeks old.
   */
  it('has nothing to grade until a cohort has finished the graded week', () => {
    const row = gradeW4Retention([cohort(1, 12, 9), cohort(2, 12, 7), cohort(3, 12, 5)]);

    expect(row.score).toBeNull();
    expect(row.reason).toBe(
      `not enough data (n=0) - no cohort has finished week ${RETENTION_GRADED_WEEK} yet`,
    );
  });

  it('scores 10 when week 4 is still holding at the W2 north star', () => {
    const row = gradeW4Retention([cohort(RETENTION_GRADED_WEEK, 20, retainedAt(1, 20))]);

    expect(row.score).toBe(10);
    expect(row.reason).toBe(
      `8 of 20 families texted back in week 4 (40%) · north star is W2 ${RETENTION_W2_TARGET * 100}%`,
    );
  });

  it('scores 6 at half the north star, and 3 at a quarter of it', () => {
    expect(
      gradeW4Retention([cohort(RETENTION_GRADED_WEEK, 40, retainedAt(0.5, 40))]).score,
    ).toBe(6);
    expect(
      gradeW4Retention([cohort(RETENTION_GRADED_WEEK, 40, retainedAt(0.25, 40))]).score,
    ).toBe(3);
  });

  /** A measured zero over real families is a 0, not a shrug (rule 3): a month-old
   * cohort where nobody texted is the worst news this scorecard can carry. */
  it('grades a cohort nobody came back to 0 rather than calling it missing data', () => {
    const row = gradeW4Retention([cohort(RETENTION_GRADED_WEEK, 15, 0)]);

    expect(row.score).toBe(0);
    expect(row.reason).not.toContain('not enough data');
    expect(row.reason).toContain('0 of 15 families texted back in week 4 (0%)');
  });

  /** Pooled across signup weeks, and ONLY over the graded week: a five-family cohort's
   * bad month must not be the grade, and week 1's healthy number must not flatter it. */
  it('pools the graded week across cohorts and ignores every other week', () => {
    const row = gradeW4Retention([
      { signupWeek: '2026-06-29', weekN: 1, cohortSize: 30, retained: 30 },
      { signupWeek: '2026-06-29', weekN: RETENTION_GRADED_WEEK, cohortSize: 20, retained: 2 },
      { signupWeek: '2026-07-06', weekN: RETENTION_GRADED_WEEK, cohortSize: 5, retained: 4 },
    ]);

    // 6 of 25 = 24%, which is 0.6 of the 40% north star — the 0.5 band.
    expect(row.score).toBe(6);
    expect(row.reason).toContain('6 of 25 families texted back in week 4 (24%)');
  });
});

describe('gradeRadarAccuracy — the weekly re-verify sweep', () => {
  /** A sweep that never ran cannot be scored 0 for accuracy: nothing was checked, so
   * nothing was got wrong. The row says the sweep is missing instead. */
  it('reports a sweep that did not run as missing data, not as a bad grade', () => {
    const row = gradeRadarAccuracy({ sweptThisWeek: false, outcomes: null });

    expect(row.score).toBeNull();
    expect(row.reason).toContain('not enough data (n=0)');
    expect(row.reason).toContain('did not run');
  });

  /** A week the sweep claimed and then left no tally for — it died mid-run, or it ran
   * before the outcome ledger existed. Distinct from "did not run", and neither one is
   * a grade: the row must not score a crash as a wrong dataset. */
  it('reports a swept week with no recorded outcomes as missing data, and says which', () => {
    const row = gradeRadarAccuracy({ sweptThisWeek: true, outcomes: null });

    expect(row.score).toBeNull();
    expect(row.reason).toContain('recorded no outcomes');
    expect(row.reason).not.toContain('did not run');
  });

  it('has nothing to grade when the sweep checked nothing', () => {
    const row = gradeRadarAccuracy({
      sweptThisWeek: true,
      outcomes: { checked: 0, confirmed: 0, discrepancies: 0, unverified: 0 },
    });

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  it('scores 10 at exactly 95% re-confirmed', () => {
    const row = gradeRadarAccuracy({
      sweptThisWeek: true,
      outcomes: { checked: 20, confirmed: 19, discrepancies: 1, unverified: 0 },
    });

    expect(row.score).toBe(10);
  });

  /**
   * 17/20 is 0.85 — the second band. The two ways a row goes unconfirmed are now
   * SEPARATE numbers, which is the whole point of the sweep recording its outcomes: "the
   * municipality moved a date" is a seed to fix today, and "we could not read the page"
   * is a scraper to fix, and a single stale count made a founder guess which week they
   * were having.
   */
  it('scores 8 at 85% and separates a moved date from a page it could not read', () => {
    const row = gradeRadarAccuracy({
      sweptThisWeek: true,
      outcomes: { checked: 20, confirmed: 17, discrepancies: 1, unverified: 2 },
    });

    expect(row.score).toBe(8);
    expect(row.reason).toContain('17 of 20');
    expect(row.reason).toContain('1 moved');
    expect(row.reason).toContain('2 could not be read');
    expect(row.reason).not.toContain('not separable');
  });

  it('scores 0 when a sweep that ran confirmed nothing', () => {
    const row = gradeRadarAccuracy({
      sweptThisWeek: true,
      outcomes: { checked: 20, confirmed: 0, discrepancies: 4, unverified: 16 },
    });

    expect(row.score).toBe(0);
  });
});

describe('gradeDeliverability — of what Hale sent, how much reached a family', () => {
  it('has nothing to grade when Hale sent nothing', () => {
    const row = gradeDeliverability([]);

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  /**
   * Inbound rows are written `status: 'delivered'` — one per text a parent sends. If
   * they reached the numerator, a chatty week would grade 10/10 no matter how many
   * sends failed. The direction filter is the whole correctness of this row.
   */
  it('ignores inbound rows entirely — a parent texting in is not a delivery', () => {
    const row = gradeDeliverability([
      { direction: 'in', status: 'delivered', count: 40 },
      { direction: 'in', status: 'delivered', count: 12 },
    ]);

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  it('does not let inbound deliveries inflate an outbound failure rate', () => {
    const withInbound = gradeDeliverability([
      { direction: 'in', status: 'delivered', count: 400 },
      { direction: 'out', status: 'delivered', count: 5 },
      { direction: 'out', status: 'failed', count: 5 },
    ]);

    expect(withInbound.score).toBe(0);
    expect(withInbound.reason).toContain('50%');
  });

  it('scores 10 at exactly 99% reached', () => {
    const row = gradeDeliverability([
      { direction: 'out', status: 'sent', count: 50 },
      { direction: 'out', status: 'delivered', count: 49 },
      { direction: 'out', status: 'failed', count: 1 },
    ]);

    expect(row.score).toBe(10);
  });

  /** 96 of 100 is the 0.95 band. The split must be visible: 2 sends that broke and 2
   * Hale deliberately held are the same ratio and completely different news. */
  it('scores 6 at 96% and separates failures from suppressions in the reason', () => {
    const row = gradeDeliverability([
      { direction: 'out', status: 'delivered', count: 96 },
      { direction: 'out', status: 'failed', count: 2 },
      { direction: 'out', status: 'suppressed_quiet_hours', count: 1 },
      { direction: 'out', status: 'suppressed_consent', count: 1 },
    ]);

    expect(row.score).toBe(6);
    expect(row.reason).toContain('2 failed');
    expect(row.reason).toContain('2 suppressed');
  });

  /** A queued row has not had its outcome yet. Counting it as a miss would grade the
   * drain's latency as a delivery failure. */
  it('leaves still-queued sends out of both sides', () => {
    const row = gradeDeliverability([
      { direction: 'out', status: 'delivered', count: 100 },
      { direction: 'out', status: 'queued', count: 900 },
    ]);

    expect(row.score).toBe(10);
    expect(row.reason).toContain('of 100');
  });
});

describe('gradeSafety — safety-lane texts Hale could only answer with a fixed door', () => {
  /** No medical text arrived at all — a measurement, and a different week from one where
   * ten arrived and all ten were answered. */
  const NO_MEDICAL = { answered: 0, fallbacks: 0 };

  it('scores 10 for a week with no safety deflection', () => {
    const row = gradeSafety([], NO_MEDICAL);

    expect(row.score).toBe(10);
  });

  it('counts only the safety lane', () => {
    const row = gradeSafety(
      [
        { lane: 'off_domain_general', count: 30 },
        { lane: 'provider_access', count: 9 },
      ],
      NO_MEDICAL,
    );

    expect(row.score).toBe(10);
  });

  it('scores 8 at two and 6 at three — the 2 and 5 bands', () => {
    expect(gradeSafety([{ lane: 'safety_critical', count: 2 }], NO_MEDICAL).score).toBe(8);
    expect(gradeSafety([{ lane: 'safety_critical', count: 3 }], NO_MEDICAL).score).toBe(6);
  });

  it('sums every safety-lane bucket before banding', () => {
    const row = gradeSafety(
      [
        { lane: 'safety_critical', count: 6 },
        { lane: 'safety_critical', count: 5 },
        { lane: 'off_domain_general', count: 99 },
      ],
      NO_MEDICAL,
    );

    expect(row.score).toBe(0);
    expect(row.reason).toContain('11');
  });

  /**
   * A medical answer that fell back IS the fixed door this row counts — a parent with a
   * hurt child got 811/911 instead of help. It was invisible while the lane's outcome
   * lived only in memory; now it bands exactly like a deflection, which is what the row's
   * own definition has always said it was.
   */
  it('bands a medical fallback as a fixed door alongside the lane deflections', () => {
    const row = gradeSafety([{ lane: 'safety_critical', count: 1 }], {
      answered: 10,
      fallbacks: 2,
    });

    // 1 deflection + 2 fallbacks = 3 doors, which is the 5 band.
    expect(row.score).toBe(6);
    expect(row.reason).toContain('2 of 10 medical answers');
  });

  it('a week whose medical answers all landed is a clean week, and says so', () => {
    const row = gradeSafety([], { answered: 12, fallbacks: 0 });

    expect(row.score).toBe(10);
    expect(row.reason).toContain('0 of 12 medical answers');
    // The caveat this row used to carry on every grade, including the 10s.
    expect(row.reason).not.toContain('not instrumented');
  });

  it('distinguishes a week with no medical text from a week whose answers all landed', () => {
    expect(gradeSafety([], NO_MEDICAL).reason).not.toBe(
      gradeSafety([], { answered: 12, fallbacks: 0 }).reason,
    );
    expect(gradeSafety([], NO_MEDICAL).reason).toContain('no medical text');
  });
});

describe('gradeUnitCost — LLM dollars per family against the budget line', () => {
  it('has nothing to grade when no family carried a recorded cost', () => {
    const row = gradeUnitCost({ totalUsd: 0, families: 0 });

    expect(row.score).toBeNull();
    expect(row.reason).toBe('not enough data (n=0)');
  });

  it('scores 10 at a quarter of the budget', () => {
    const totalUsd = UNIT_COST_BUDGET_USD_PER_FAMILY * 0.25 * 4;

    expect(gradeUnitCost({ totalUsd, families: 4 }).score).toBe(10);
  });

  it('scores 9 at half the budget', () => {
    const totalUsd = UNIT_COST_BUDGET_USD_PER_FAMILY * 0.5 * 10;

    expect(gradeUnitCost({ totalUsd, families: 10 }).score).toBe(9);
  });

  it('scores 6 exactly ON the budget line, and states both numbers', () => {
    const row = gradeUnitCost({ totalUsd: UNIT_COST_BUDGET_USD_PER_FAMILY * 5, families: 5 });

    expect(row.score).toBe(6);
    expect(row.reason).toContain(UNIT_COST_BUDGET_USD_PER_FAMILY.toFixed(2));
  });

  it('scores 0 well past the budget', () => {
    const totalUsd = UNIT_COST_BUDGET_USD_PER_FAMILY * 1.55 * 3;

    expect(gradeUnitCost({ totalUsd, families: 3 }).score).toBe(0);
  });
});
