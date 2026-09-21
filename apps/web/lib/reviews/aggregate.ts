import { type Database, schema } from '@hale/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { OfferedCandidate } from '~/lib/coach/tools';
import { matchAreaKey, normalizeFsa } from '~/lib/village/intros/matcher';
import type { SubjectSource } from './subject';

/**
 * WHAT OTHER FAMILIES NEARBY SAID — and the rules about when Hale may say any of it.
 *
 * THREE IS THE FLOOR, and it is an INDEX rather than a query clause. With
 * `UNIQUE (family_id, subject_source, subject_ref)` on the table, `count(*)` IS
 * `count(distinct family_id)`, so a reader who forgets DISTINCT cannot inflate the
 * threshold — and because nothing is materialised, erasure needs no recompute: one
 * `DELETE FROM families` cascades and the next read is already the new answer.
 */
export const MIN_FAMILIES_FOR_AGGREGATE = 3;

export const ACTIVITY_REVIEWS_SURFACE_ENV = 'ACTIVITY_REVIEWS_SURFACE';

/**
 * The read's own dark flag, off for months by design: it stays off until three REAL
 * households have answered about one subject, and the nine production families are test
 * users. Strict equality on the literal, for the trailing-newline reason every flag in
 * this product now states.
 */
export function activityReviewsSurfaceEnabled(): boolean {
  return process.env[ACTIVITY_REVIEWS_SURFACE_ENV] === 'true';
}

export interface ReviewSubjectRef {
  source: SubjectSource;
  ref: string;
}

export interface SubjectVerdicts {
  /** count(*) — which IS count(distinct family_id), by the index. */
  families: number;
  worthIt: number;
  /** Used to RANK, never to speak: a majority-negative subject sorts last and is dropped
   * when there is an alternative, with no sentence about it anywhere. */
  majorityNegative: boolean;
  /** At most two, each held by at least two families. */
  topTags: string[];
}

/** The map key. One function, so two readers cannot key the same subject differently. */
export function subjectKey(subject: ReviewSubjectRef): string {
  return `${subject.source}:${subject.ref}`;
}

/**
 * The pooled answer per subject, or nothing for a subject fewer than
 * {@link MIN_FAMILIES_FOR_AGGREGATE} families have answered about.
 *
 * `did_not_attend` rows are excluded from the count: a family that did not go has no
 * opinion, and counting them would inflate k toward the threshold with silence.
 */
export async function readSubjectVerdicts(
  database: Database,
  subjects: readonly ReviewSubjectRef[],
  areaKey: string,
): Promise<Map<string, SubjectVerdicts>> {
  const out = new Map<string, SubjectVerdicts>();
  if (subjects.length === 0) return out;

  const rows = await database
    .select({
      subjectSource: schema.activityReviews.subjectSource,
      subjectRef: schema.activityReviews.subjectRef,
      verdict: schema.activityReviews.verdict,
      tags: schema.activityReviews.tags,
    })
    .from(schema.activityReviews)
    .where(
      and(
        eq(schema.activityReviews.areaKey, areaKey),
        inArray(
          schema.activityReviews.subjectRef,
          subjects.map((subject) => subject.ref),
        ),
        ne(schema.activityReviews.verdict, 'did_not_attend'),
      ),
    );

  const wanted = new Set(subjects.map(subjectKey));
  const grouped = new Map<string, { worthIt: number; notWorthIt: number; tags: string[][] }>();
  for (const row of rows) {
    const key = subjectKey({ source: row.subjectSource, ref: row.subjectRef });
    // The `inArray` above filters on the ref alone, which is the indexed column; the
    // pair is what identifies a subject, so the source is checked here.
    if (!wanted.has(key)) continue;
    const bucket = grouped.get(key) ?? { worthIt: 0, notWorthIt: 0, tags: [] };
    if (row.verdict === 'worth_it') bucket.worthIt += 1;
    else bucket.notWorthIt += 1;
    bucket.tags.push(row.tags);
    grouped.set(key, bucket);
  }

  for (const [key, bucket] of grouped) {
    const families = bucket.worthIt + bucket.notWorthIt;
    if (families < MIN_FAMILIES_FOR_AGGREGATE) continue;
    out.set(key, {
      families,
      worthIt: bucket.worthIt,
      majorityNegative: bucket.notWorthIt > bucket.worthIt,
      topTags: topTagsOf(bucket.tags),
    });
  }
  return out;
}

/** At most two, each held by at least two families — one household's tag is one
 * household's morning, not something to tell a stranger about a business. */
function topTagsOf(perFamily: readonly string[][]): string[] {
  const counts = new Map<string, number>();
  for (const tags of perFamily) {
    for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .slice(0, 2)
    .map(([tag]) => tag);
}

/**
 * The one sentence Hale may say, or null.
 *
 * IT SAYS ONLY THE POSITIVE COUNT, never a denominator: "3 of 4" at k=3 is a negative
 * aggregate by arithmetic. And no adjective — the parents said a verdict, not a review.
 *
 * NEGATIVES ARE NEVER SPOKEN, ONLY RANKED. A majority-negative subject returns null here
 * and sorts last where the offers are chosen; there is no warning sentence anywhere,
 * because an unverified claim about a small business with no right of reply is not
 * something this product publishes, and a demotion is strictly better for the parent than
 * a warning they have to act on.
 */
export function renderVerdictClause(
  displayName: string,
  verdicts: SubjectVerdicts | undefined,
): string | null {
  if (!verdicts) return null;
  if (verdicts.families < MIN_FAMILIES_FOR_AGGREGATE) return null;
  if (verdicts.majorityNegative) return null;
  return `${verdicts.worthIt} families near you say ${displayName} is worth it.`;
}

/** The shared identity behind an offer the coach just made, or null when it has none. */
export function offeredSubject(offer: OfferedCandidate): ReviewSubjectRef | null {
  if (offer.placeId) return { source: 'place', ref: offer.placeId };
  if (offer.civicVenueId) return { source: 'civic_venue', ref: offer.civicVenueId };
  return null;
}

/**
 * The coarse area a count is pooled over — `matchAreaKey` over `normalizeFsa`, reused
 * rather than re-decided, because the intros lane already settled what "a family near
 * you" means. Null when the family's area is not FSA-shaped, which is the honest answer
 * for a household whose `area_coarse` fell back to a city of three million.
 */
export async function familyAreaKey(
  database: Database,
  familyId: string,
): Promise<string | null> {
  const [family] = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const fsa = normalizeFsa(family?.areaCoarse ?? null);
  return fsa === null ? null : matchAreaKey(fsa);
}

/**
 * THE WHOLE SURFACE DECISION, as one pure function over what the turn already knows.
 *
 * It FAILS CLOSED, and every branch that returns null is a case where the clause could
 * land on the wrong activity:
 *   · nothing offered, or nothing offered has a pooled answer → nothing to say;
 *   · TWO offers have one → the reply names two things and a count cannot say which;
 *   · the offer with the count is majority-negative → never spoken, only ranked.
 *
 * The caller still has to check that the body names it; that check lives in
 * `toSmsReply`, because only the FITTED body is what the parent will read.
 */
export function nearbyClauseTarget(
  offers: readonly OfferedCandidate[],
  verdicts: ReadonlyMap<string, SubjectVerdicts>,
): { title: string; clause: string; otherTitles: string[] } | null {
  const withClause = offers
    .map((offer) => {
      const subject = offeredSubject(offer);
      // THE VENUE, NOT THE PROGRAMME. The subject is a place or a civic venue, so the
      // three households answered about the branch — "the Saturday storytime is worth
      // it" would put their answer on a timetable they were never asked about (founder
      // decision 2). The TITLE is still what the body has to name, because that is what
      // the model wrote about.
      const clause = subject
        ? renderVerdictClause(offer.venue, verdicts.get(subjectKey(subject)))
        : null;
      return clause === null ? null : { title: offer.title, clause };
    })
    .filter((entry): entry is { title: string; clause: string } => entry !== null);

  if (withClause.length !== 1) return null;
  const only = withClause[0] as { title: string; clause: string };
  return {
    title: only.title,
    clause: only.clause,
    otherTitles: offers.map((offer) => offer.title).filter((title) => title !== only.title),
  };
}
