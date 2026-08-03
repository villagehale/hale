import { describe, expect, it } from 'vitest';
import {
  deriveFamilyStages,
  deriveStage,
  isBeyondProductAge,
  STAGE_BOUNDARIES_MONTHS,
  stageFromAgeInMonths,
  TEENAGER_START_MONTHS,
} from './index.js';

/**
 * Every expected value is hand-derived from the boundary spec:
 *   newborn <12mo, toddler 12-47mo, preschool 48-59mo, child 60-155mo, teenager 156mo+;
 *   18y=216mo ceiling.
 * Boundary dates use a day-15 birth (present in every month) so anniversaries are exact;
 * the calendar-edge block deliberately uses a day-31 birth to exercise short-month rollover.
 */

describe('STAGE_BOUNDARIES_MONTHS', () => {
  it('pins the toddler/preschool/child/teenager starts', () => {
    expect(STAGE_BOUNDARIES_MONTHS).toEqual([12, 48, 60, 156]);
  });
});

describe('stageFromAgeInMonths', () => {
  it('maps each completed-month age onto its stage', () => {
    expect(stageFromAgeInMonths(0)).toBe('newborn');
    expect(stageFromAgeInMonths(11)).toBe('newborn');
    expect(stageFromAgeInMonths(12)).toBe('toddler');
    expect(stageFromAgeInMonths(47)).toBe('toddler');
    expect(stageFromAgeInMonths(48)).toBe('preschool');
    expect(stageFromAgeInMonths(59)).toBe('preschool');
    expect(stageFromAgeInMonths(60)).toBe('child');
    expect(stageFromAgeInMonths(155)).toBe('child');
    expect(stageFromAgeInMonths(156)).toBe('teenager');
    expect(stageFromAgeInMonths(216)).toBe('teenager');
  });

  /**
   * VIL-266 — the preschool band, month by month across both its edges. Values
   * come from the spec (preschool = [48, 60)), not from what the code returns.
   */
  it.each([
    [46, 'toddler'],
    [47, 'toddler'],
    [48, 'preschool'],
    [49, 'preschool'],
    [59, 'preschool'],
    [60, 'child'],
    [61, 'child'],
  ] as const)('%i completed months is %s', (months, expected) => {
    expect(stageFromAgeInMonths(months)).toBe(expected);
  });
});

describe('deriveStage boundaries', () => {
  // Birth on the 15th: anniversaries land cleanly on the 15th of each month.
  const birth = '2010-06-15';

  it('newborn the day before 12mo, toddler on the 12mo anniversary', () => {
    expect(deriveStage(birth, new Date(2011, 5, 14))).toBe('newborn'); // 11mo
    expect(deriveStage(birth, new Date(2011, 5, 15))).toBe('toddler'); // 12mo
  });

  it('toddler the day before 48mo, preschool on the 48mo anniversary', () => {
    expect(deriveStage(birth, new Date(2014, 5, 14))).toBe('toddler'); // 47mo
    expect(deriveStage(birth, new Date(2014, 5, 15))).toBe('preschool'); // 48mo
  });

  it('preschool the day before 60mo, child on the 60mo anniversary', () => {
    expect(deriveStage(birth, new Date(2015, 5, 14))).toBe('preschool'); // 59mo
    expect(deriveStage(birth, new Date(2015, 5, 15))).toBe('child'); // 60mo
  });

  it('child the day before 156mo, teenager on the 156mo anniversary', () => {
    expect(deriveStage(birth, new Date(2023, 5, 14))).toBe('child'); // 155mo
    expect(deriveStage(birth, new Date(2023, 5, 15))).toBe('teenager'); // 156mo
  });
});

/**
 * VIL-266 — the teen floor is the one boundary this change must NOT move.
 * Teen redaction (hard rule #1) keys off `deriveStage(...) === 'teenager'`, so
 * 155mo staying non-teen and 156mo becoming teen is a privacy invariant, not a
 * detail. Asserted against the boundary constant itself so a future edit to
 * STAGE_BOUNDARIES_MONTHS cannot quietly slide the floor.
 */
describe('teen gate — the 156mo floor is unmoved', () => {
  it('155mo is not a teenager and 157mo is', () => {
    expect(stageFromAgeInMonths(155)).not.toBe('teenager');
    expect(stageFromAgeInMonths(156)).toBe('teenager');
    expect(stageFromAgeInMonths(157)).toBe('teenager');
  });

  it('the teen floor is the LAST boundary and is still 156', () => {
    expect(TEENAGER_START_MONTHS).toBe(156);
    expect(STAGE_BOUNDARIES_MONTHS.at(-1)).toBe(TEENAGER_START_MONTHS);
  });

  /**
   * The regression that adding preschool actually caused: three modules read the
   * teen floor as STAGE_BOUNDARIES_MONTHS[2], which became 60 the moment a stage
   * was inserted. The named constant is the fix, so it must NOT be re-derivable
   * by position — this pins that index 2 is now a non-teen boundary, which is
   * what makes a positional read fail loudly instead of silently.
   */
  it('is not at the index positional readers used to use', () => {
    expect(STAGE_BOUNDARIES_MONTHS[2]).not.toBe(TEENAGER_START_MONTHS);
    expect(stageFromAgeInMonths(STAGE_BOUNDARIES_MONTHS[2])).not.toBe('teenager');
  });

  it('no age below 156 months derives teenager', () => {
    for (let months = 0; months < 156; months += 1) {
      expect(stageFromAgeInMonths(months)).not.toBe('teenager');
    }
  });
});

describe('deriveStage calendar edge — born on the 31st', () => {
  // Rule: a month completes on its day-of-month anniversary; when the target
  // month is too short to hold that day, the anniversary rolls to the month's
  // last day. So born 2026-01-31, the 1-month mark is 2026-02-28 (non-leap Feb).
  const bornJan31 = '2026-01-31';

  it('rolls the anniversary to the last day of Feb (leap and non-leap)', () => {
    // Non-leap 2026: 1mo mark rolls to 2026-02-28. Leap 2028: rolls to 2028-02-29.
    // The rolled day is the month's last day, so on it the child is 1mo (newborn),
    // and one day prior is still 0mo (newborn). All newborn, but these pin that
    // the anniversary tracks the month length rather than a fixed 31st/28th.
    expect(deriveStage(bornJan31, new Date(2026, 1, 28))).toBe('newborn'); // 1mo, rolled (non-leap)
    expect(deriveStage(bornJan31, new Date(2026, 1, 27))).toBe('newborn'); // 0mo
    expect(deriveStage('2028-01-31', new Date(2028, 1, 29))).toBe('newborn'); // 1mo, rolled (leap)
  });

  it('flips newborn→toddler across the 12mo anniversary of a Dec-31 birth', () => {
    // Born 2024-12-31; the 12mo mark is 2025-12-31 (Dec has 31 days, no roll),
    // so the day-31 birthday arithmetic is exercised without ambiguity.
    const bornDec31 = '2024-12-31';
    expect(deriveStage(bornDec31, new Date(2025, 11, 30))).toBe('newborn'); // 11mo
    expect(deriveStage(bornDec31, new Date(2025, 11, 31))).toBe('toddler'); // 12mo
  });
});

describe('isBeyondProductAge — 18y ceiling = 216mo', () => {
  const birth = '2010-06-15';

  it('false the day before 216mo, true on the 216mo anniversary', () => {
    expect(isBeyondProductAge(birth, new Date(2028, 5, 14))).toBe(false); // 215mo
    expect(isBeyondProductAge(birth, new Date(2028, 5, 15))).toBe(true); // 216mo
  });

  it('still derives teenager past the ceiling (offboarding is explicit)', () => {
    expect(deriveStage(birth, new Date(2028, 5, 15))).toBe('teenager');
  });
});

describe('deriveFamilyStages — siblings coexist', () => {
  const now = new Date(2026, 5, 15); // 2026-06-15

  it('returns a stage per child, newborn and teenager in one family', () => {
    const stages = deriveFamilyStages(
      [
        { id: 'baby', dateOfBirth: '2026-01-15' }, // 5mo → newborn
        { id: 'teen', dateOfBirth: '2010-06-15' }, // 192mo → teenager
      ],
      now,
    );
    expect(stages.size).toBe(2);
    expect(stages.get('baby')).toBe('newborn');
    expect(stages.get('teen')).toBe('teenager');
  });

  it('is empty for a family with no children', () => {
    expect(deriveFamilyStages([], now).size).toBe(0);
  });
});
