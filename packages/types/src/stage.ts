/**
 * Family stage — derived per-child from date of birth, never stored.
 * The product spans a childhood; each child sits in exactly one stage,
 * and stages coexist across siblings in the same family.
 */
export type FamilyStage = 'newborn' | 'toddler' | 'preschool' | 'child' | 'teenager';

/**
 * The stages as a runtime tuple, childhood-ordered. The `FamilyStage` union is
 * type-only (not iterable at runtime), so this is the single source for code that
 * must enumerate or validate a stage value — a server-side guard, a stage picker.
 * `satisfies` ties it to the union, so adding a stage to the type forces it here.
 */
export const FAMILY_STAGES = ['newborn', 'toddler', 'preschool', 'child', 'teenager'] as const satisfies readonly FamilyStage[];

/**
 * The teen floor — 13 years in completed months.
 *
 * Named, and exported, because raw-content redaction (hard rule #1) keys off it.
 * Callers MUST read this rather than index into `STAGE_BOUNDARIES_MONTHS`: adding
 * the preschool stage (VIL-266) shifted the teen floor from index 2 to index 3,
 * which silently re-pointed three positional readers at 60 months — a five-year-old
 * — and only one of them had a test that noticed.
 */
export const TEENAGER_START_MONTHS = 156;

/**
 * Stage boundaries in completed months. Config, not magic numbers:
 * newborn <12mo, toddler 12-47mo, preschool 48-59mo, child 60-155mo, teenager 156mo+.
 *
 * The preschool band (VIL-266) exists because 48-155mo was one bucket over two
 * different childhoods — a four-year-old and a twelve-year-old are not searched,
 * framed, or programmed for alike.
 */
export const STAGE_BOUNDARIES_MONTHS = [12, 48, 60, TEENAGER_START_MONTHS] as const;

/** 18 years in months — past this the family is out of product scope. */
const PRODUCT_AGE_CEILING_MONTHS = 18 * 12;

interface CalendarDate {
  year: number;
  month: number; // 0-indexed
  day: number;
}

/**
 * Read a value as the calendar date the caller meant. A date-only ISO string
 * (`YYYY-MM-DD`) is its literal calendar day, zone-independent; any other input
 * is read by its local calendar fields. This avoids the UTC-vs-local trap where
 * `new Date('2010-06-15')` parses as UTC midnight and reads as the prior day in
 * negative-offset zones.
 */
function toCalendarDate(value: string | Date): CalendarDate {
  let date: Date;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
    }
    date = new Date(value);
  } else {
    date = value;
  }
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

/**
 * Completed calendar months between birth and now. A month completes on its
 * day-of-month anniversary; when the target month is too short to hold that day
 * (e.g. born on the 31st, now February), the anniversary rolls to the last day
 * of the shorter month — so a child born 2026-01-31 is 1 month old on 2026-02-28.
 */
function completedMonths(dateOfBirth: CalendarDate, now: CalendarDate): number {
  let months = (now.year - dateOfBirth.year) * 12 + (now.month - dateOfBirth.month);

  const lastDayOfNowMonth = new Date(now.year, now.month + 1, 0).getDate();
  const anniversaryDay = Math.min(dateOfBirth.day, lastDayOfNowMonth);
  if (now.day < anniversaryDay) {
    months -= 1;
  }

  return months;
}

/**
 * Shared core: map a completed-month age onto a stage. deriveStage delegates
 * here so the month arithmetic lives in one place.
 */
export function stageFromAgeInMonths(months: number): FamilyStage {
  const [toddlerStart, preschoolStart, childStart, teenagerStart] = STAGE_BOUNDARIES_MONTHS;
  if (months < toddlerStart) return 'newborn';
  if (months < preschoolStart) return 'toddler';
  if (months < childStart) return 'preschool';
  if (months < teenagerStart) return 'child';
  return 'teenager';
}

/** Derive a single child's stage from their date of birth. Pure, no I/O. */
export function deriveStage(dateOfBirth: string | Date, now: Date = new Date()): FamilyStage {
  return stageFromAgeInMonths(
    completedMonths(toCalendarDate(dateOfBirth), toCalendarDate(now)),
  );
}

/**
 * A child's age in completed calendar months. Shares the same month arithmetic
 * as deriveStage, so the classifier's childrenAgesMonths context slice and the
 * stage boundaries can never disagree. Pure, no I/O.
 */
export function ageInMonths(dateOfBirth: string | Date, now: Date = new Date()): number {
  return completedMonths(toCalendarDate(dateOfBirth), toCalendarDate(now));
}

/**
 * Whether a child has aged past the product's 18-year ceiling. deriveStage
 * still returns 'teenager' past this point; callers use this to offboard
 * explicitly rather than silently treating adults as teens.
 */
export function isBeyondProductAge(dateOfBirth: string | Date, now: Date = new Date()): boolean {
  return (
    completedMonths(toCalendarDate(dateOfBirth), toCalendarDate(now)) >= PRODUCT_AGE_CEILING_MONTHS
  );
}

/**
 * Derive stages for every child in a family. Stages coexist per child — a
 * newborn and a teenager can share one family.
 */
export function deriveFamilyStages(
  children: ReadonlyArray<{ id: string; dateOfBirth: string | Date }>,
  now: Date = new Date(),
): Map<string, FamilyStage> {
  return new Map(children.map((child) => [child.id, deriveStage(child.dateOfBirth, now)]));
}
