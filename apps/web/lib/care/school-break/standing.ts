import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { WeekdayCareFact } from '~/lib/care/weekday';
import type { SchoolBreakFact } from './facts';
import { anyStillKidMail } from './kept-mail';

/**
 * VIL-685 · WHETHER A SCHOOL'S BREAK STILL APPLIES TO THIS FAMILY, from what is true now,
 * not from what was true when it was filed. One check, run by both the sweep (which
 * retires a break that no longer stands) and the reader the break question uses (which
 * never names one), so a parent's correction takes effect the moment it is written.
 *
 * A break read off a school's page stands only while
 *   - the family still has a child of school age who the parent has not said is at
 *     daycare (a daycare-only family is never given a school's break), and
 *   - at least one of the emails that named the school is still plain kid mail
 *     (kept-mail.ts): a "that's mine" on it withdraws the school it named.
 * The parent's own answer is theirs and stands on their word.
 */

/** Junior kindergarten starts in September of the year a child turns four. */
const JK_START_AGE = 4;
/** Grade 12 starts in September of the year a child turns seventeen, and they turn
 * eighteen during it: the last school year with a winter break of theirs. */
const LAST_SCHOOL_YEAR_START_AGE = 17;

export type BoardBreakStanding = 'stands' | 'no_school_child' | 'source_mail_withdrawn';

/** A child of school age this school year whose parent has not said they are at daycare. */
export async function hasSchoolAgeChild(
  database: Database,
  familyId: string,
  schoolYear: string,
  care: readonly Pick<WeekdayCareFact, 'childId' | 'care'>[],
): Promise<boolean> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const startYear = Number(schoolYear.slice(0, 4));
  const atDaycare = new Set(
    care.filter((fact) => fact.care === 'daycare').map((fact) => fact.childId),
  );
  return children.some((child) => {
    const age = startYear - Number(child.dateOfBirth.slice(0, 4));
    return age >= JK_START_AGE && age <= LAST_SCHOOL_YEAR_START_AGE && !atDaycare.has(child.id);
  });
}

export async function boardBreakStanding(
  database: Database,
  fact: SchoolBreakFact,
  care: readonly Pick<WeekdayCareFact, 'childId' | 'care'>[],
): Promise<BoardBreakStanding> {
  if (fact.source === 'parent') return 'stands';
  if (!(await hasSchoolAgeChild(database, fact.familyId, fact.schoolYear, care))) {
    return 'no_school_child';
  }
  if (!(await anyStillKidMail(database, fact.familyId, fact.sourceMail))) {
    return 'source_mail_withdrawn';
  }
  return 'stands';
}
