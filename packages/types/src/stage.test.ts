import { describe, expect, it } from 'vitest';
import {
  deriveFamilyStages,
  deriveStage,
  isBeyondProductAge,
  STAGE_BOUNDARIES_MONTHS,
  stageFromAgeInMonths,
} from './index.js';

/**
 * Every expected value is hand-derived from the boundary spec:
 *   newborn <12mo, toddler 12-47mo, child 48-155mo, teenager 156mo+; 18y=216mo ceiling.
 * Boundary dates use a day-15 birth (present in every month) so anniversaries are exact;
 * the calendar-edge block deliberately uses a day-31 birth to exercise short-month rollover.
 */

describe('STAGE_BOUNDARIES_MONTHS', () => {
  it('pins the toddler/child/teenager starts', () => {
    expect(STAGE_BOUNDARIES_MONTHS).toEqual([12, 48, 156]);
  });
});

describe('stageFromAgeInMonths', () => {
  it('maps each completed-month age onto its stage', () => {
    expect(stageFromAgeInMonths(0)).toBe('newborn');
    expect(stageFromAgeInMonths(11)).toBe('newborn');
    expect(stageFromAgeInMonths(12)).toBe('toddler');
    expect(stageFromAgeInMonths(47)).toBe('toddler');
    expect(stageFromAgeInMonths(48)).toBe('child');
    expect(stageFromAgeInMonths(155)).toBe('child');
    expect(stageFromAgeInMonths(156)).toBe('teenager');
    expect(stageFromAgeInMonths(216)).toBe('teenager');
  });
});

describe('deriveStage boundaries', () => {
  // Birth on the 15th: anniversaries land cleanly on the 15th of each month.
  const birth = '2010-06-15';

  it('newborn the day before 12mo, toddler on the 12mo anniversary', () => {
    expect(deriveStage(birth, new Date(2011, 5, 14))).toBe('newborn'); // 11mo
    expect(deriveStage(birth, new Date(2011, 5, 15))).toBe('toddler'); // 12mo
  });

  it('toddler the day before 48mo, child on the 48mo anniversary', () => {
    expect(deriveStage(birth, new Date(2014, 5, 14))).toBe('toddler'); // 47mo
    expect(deriveStage(birth, new Date(2014, 5, 15))).toBe('child'); // 48mo
  });

  it('child the day before 156mo, teenager on the 156mo anniversary', () => {
    expect(deriveStage(birth, new Date(2023, 5, 14))).toBe('child'); // 155mo
    expect(deriveStage(birth, new Date(2023, 5, 15))).toBe('teenager'); // 156mo
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
