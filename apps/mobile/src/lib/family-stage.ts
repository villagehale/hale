/**
 * Family stage, derived per-child from date of birth — a mobile replica of
 * @hale/types `deriveStage` (packages/types/src/stage.ts). The native bundle
 * can't import package code (it pulls in Node), so the boundaries and the
 * completed-month arithmetic are hand-mirrored here, the same rule as the INTENTS
 * copy in intake. Kept pure and native-import-free so the pre-auth preview's stage
 * derivation is unit-testable under the src/lib vitest runner.
 *
 * The one consumer is the anonymous preview: it needs a stage BEFORE any account
 * exists, from the DOBs already in the local draft, so the /api/preview body
 * carries a coarse stage and never a date of birth (rule #1).
 */

export type FamilyStage = 'newborn' | 'toddler' | 'child' | 'teenager';

/** Stage boundaries in completed months — mirrors STAGE_BOUNDARIES_MONTHS:
 * newborn <12mo, toddler 12–47mo, child 48–155mo, teenager 156mo+. */
const STAGE_BOUNDARIES_MONTHS = [12, 48, 156] as const;

interface CalendarDate {
  year: number;
  month: number; // 0-indexed
  day: number;
}

/**
 * Read a value as the calendar day the caller meant. A `YYYY-MM-DD` string is its
 * literal calendar day, zone-independent — avoiding the UTC-vs-local trap where
 * `new Date('2010-06-15')` parses as UTC midnight and reads as the prior day in
 * negative-offset zones. Mirrors the canonical toCalendarDate.
 */
function toCalendarDate(value: string | Date): CalendarDate {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
    }
    const parsed = new Date(value);
    return { year: parsed.getFullYear(), month: parsed.getMonth(), day: parsed.getDate() };
  }
  return { year: value.getFullYear(), month: value.getMonth(), day: value.getDate() };
}

/** Completed calendar months between birth and now; the anniversary rolls to the
 * last day of a shorter target month. Mirrors the canonical completedMonths. */
function completedMonths(dateOfBirth: CalendarDate, now: CalendarDate): number {
  let months = (now.year - dateOfBirth.year) * 12 + (now.month - dateOfBirth.month);
  const lastDayOfNowMonth = new Date(now.year, now.month + 1, 0).getDate();
  const anniversaryDay = Math.min(dateOfBirth.day, lastDayOfNowMonth);
  if (now.day < anniversaryDay) months -= 1;
  return months;
}

/** Map a completed-month age onto a stage. */
export function stageFromAgeInMonths(months: number): FamilyStage {
  const [toddlerStart, childStart, teenagerStart] = STAGE_BOUNDARIES_MONTHS;
  if (months < toddlerStart) return 'newborn';
  if (months < childStart) return 'toddler';
  if (months < teenagerStart) return 'child';
  return 'teenager';
}

/** Derive a single child's stage from their date of birth. Pure, no I/O. */
export function deriveStage(dateOfBirth: string | Date, now: Date = new Date()): FamilyStage {
  return stageFromAgeInMonths(completedMonths(toCalendarDate(dateOfBirth), toCalendarDate(now)));
}

/**
 * The stage of the YOUNGEST dated child — the stage the anonymous preview asks
 * for, because discovery is tailored to the newest arrival and a teen sibling must
 * not suppress a newborn's activities. Children without a birthday are skipped;
 * `null` means there is nothing to preview yet. The result is `teenager` only when
 * every dated child is a teenager, which is the honest teen-only preview boundary
 * (the API returns no activities for that stage by design, rule #1).
 */
export function youngestChildStage(
  children: ReadonlyArray<{ dateOfBirth: string }>,
  now: Date = new Date(),
): FamilyStage | null {
  const dated = children.filter((c) => c.dateOfBirth);
  if (dated.length === 0) return null;
  const youngest = dated.reduce((a, b) => (a.dateOfBirth > b.dateOfBirth ? a : b));
  return deriveStage(youngest.dateOfBirth, now);
}
