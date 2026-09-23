import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { type ReviewSubjectRef, subjectKey } from './aggregate';

/**
 * VIL-366 · THIS household's own verdicts, applied to the next find.
 *
 * Cross-family speech stays in `withoutPooledNegatives` / `renderVerdictClause`
 * (hale#677: k>=3, majority-negative ranked and never spoken). A single family's
 * own `activity_reviews` row does not meet that floor, and it must still change
 * what THIS household is offered next. This module returns an order, never a
 * sentence.
 *
 * `did_not_attend` is no opinion. `not_worth_it` is dropped when any other
 * option remains, and kept last only when every option is one this family
 * already disliked. Nothing here is said out loud.
 */

export interface HouseholdFindBias {
  /** `${source}:${ref}` keys this family marked `worth_it`. */
  prefer: ReadonlySet<string>;
  /** `${source}:${ref}` keys this family marked `not_worth_it`. */
  avoid: ReadonlySet<string>;
}

export function emptyHouseholdFindBias(): HouseholdFindBias {
  return { prefer: new Set(), avoid: new Set() };
}

export function biasFromVerdicts(
  rows: readonly { source: string; ref: string; verdict: string }[],
): HouseholdFindBias {
  const prefer = new Set<string>();
  const avoid = new Set<string>();
  for (const row of rows) {
    const key = subjectKey({ source: row.source as ReviewSubjectRef['source'], ref: row.ref });
    prefer.delete(key);
    avoid.delete(key);
    if (row.verdict === 'worth_it') prefer.add(key);
    else if (row.verdict === 'not_worth_it') avoid.add(key);
  }
  return { prefer, avoid };
}

/**
 * The shared identity a village row can be biased on. Place wins over civic venue,
 * matching `offeredSubject`. A row with neither is neutral — title matching is
 * forbidden (reviews/subject.ts).
 */
export function candidateReviewSubject(candidate: {
  placeId?: string | null;
  civicVenueId?: string | null;
}): ReviewSubjectRef | null {
  if (candidate.placeId) return { source: 'place', ref: candidate.placeId };
  if (candidate.civicVenueId) return { source: 'civic_venue', ref: candidate.civicVenueId };
  return null;
}

/**
 * Stable re-order. Prefer floats first. Avoid is dropped when anything else
 * remains; if every item is avoided, they stay, in the order they arrived.
 * A missing subject is neutral.
 */
export function biasFindOrder<T>(
  items: readonly T[],
  subjectOf: (item: T) => ReviewSubjectRef | null,
  bias: HouseholdFindBias,
): T[] {
  const prefer: T[] = [];
  const neutral: T[] = [];
  const avoid: T[] = [];
  for (const item of items) {
    const subject = subjectOf(item);
    const key = subject ? subjectKey(subject) : null;
    if (key !== null && bias.prefer.has(key)) prefer.push(item);
    else if (key !== null && bias.avoid.has(key)) avoid.push(item);
    else neutral.push(item);
  }
  if (prefer.length + neutral.length === 0) return avoid;
  return [...prefer, ...neutral];
}

/** This family's rows only. The unique index is one verdict per subject. */
export async function readHouseholdFindBias(
  database: Database,
  familyId: string,
): Promise<HouseholdFindBias> {
  const rows = await database
    .select({
      subjectSource: schema.activityReviews.subjectSource,
      subjectRef: schema.activityReviews.subjectRef,
      verdict: schema.activityReviews.verdict,
    })
    .from(schema.activityReviews)
    .where(eq(schema.activityReviews.familyId, familyId));
  return biasFromVerdicts(
    rows.map((row) => ({ source: row.subjectSource, ref: row.subjectRef, verdict: row.verdict })),
  );
}
