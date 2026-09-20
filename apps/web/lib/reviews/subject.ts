import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * WHICH SHARED THING A PLACEMENT WAS, so one household's verdict about it can reach
 * another household — and, far more often, why it was none of them.
 *
 * NOTHING HERE IS GUESSED. The subject is derived from the action that placed the row,
 * never from a model and never from a title: matching a placement's title back against
 * candidate rows would be a fuzzy join deciding which VENUE an opinion lands on, and a
 * wrong hit sends one family's opinion of place A to another family about place B. Every
 * hop is family-scoped, and everything the resolver cannot prove is a named refusal.
 */
export type SubjectSource = 'place' | 'civic_venue';

export type SubjectUnresolved =
  /** Parent-authored, email-sourced, or (after the booked-detection widening) a booking:
   * nothing placed it, so there is nothing to read provenance off. */
  | 'no_placing_action'
  /** The action carries neither the typed `sourceRef` nor the legacy `candidate_id`. */
  | 'no_provenance_in_payload'
  /** `sourceRef.table` is something other than `village_candidates` — the week-plan
   * composer also writes `children` and `family_events` refs, and reading one of those
   * as a venue is exactly the bug this check exists for. */
  | 'foreign_source_table'
  /** The candidate row is unreadable — erased, or another family's. NOT superseded: a
   * three-day-old placement's candidate is routinely retired by the next run. */
  | 'candidate_gone'
  /** The candidate has neither a Google place id nor a civic venue id, so there is no
   * string two families could ever both hold. Every second civic row before 0122. */
  | 'no_shared_identity';

export type ReviewSubject =
  | { source: SubjectSource; ref: string }
  | { unresolved: SubjectUnresolved };

export async function resolveReviewSubject(
  database: Database,
  input: { familyId: string; familyEventId: string },
): Promise<ReviewSubject> {
  const [event] = await database
    .select({ placedByActionId: schema.familyEvents.placedByActionId })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, input.familyEventId),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!event?.placedByActionId) return { unresolved: 'no_placing_action' };

  // FAMILY-SCOPED EXPLICITLY. `placed_by_action_id` is deliberately FK-less — it is a
  // claim key, not a reference — so nothing in the schema stops it naming another
  // household's action, and this join is the only place that can refuse one.
  const [action] = await database
    .select({
      sourceRef: sql<{
        table?: unknown;
        id?: unknown;
      } | null>`${schema.actions.payload} -> 'sourceRef'`,
      legacyCandidateId: sql<string | null>`${schema.events.payload} ->> 'candidate_id'`,
    })
    .from(schema.actions)
    .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
    .where(
      and(
        eq(schema.actions.id, event.placedByActionId),
        eq(schema.actions.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!action) return { unresolved: 'no_placing_action' };

  // THE TYPED PROVENANCE FIRST — what the Sunday loop and the texted add both write.
  // The legacy `candidate_id` on the EVENT is the web dashboard's older shape and is
  // read only when the action carries nothing.
  let candidateId: string;
  const ref = action.sourceRef;
  if (ref && typeof ref === 'object') {
    if (ref.table !== 'village_candidates') return { unresolved: 'foreign_source_table' };
    if (typeof ref.id !== 'string' || ref.id === '') {
      return { unresolved: 'no_provenance_in_payload' };
    }
    candidateId = ref.id;
  } else if (action.legacyCandidateId) {
    candidateId = action.legacyCandidateId;
  } else {
    return { unresolved: 'no_provenance_in_payload' };
  }

  // NO `superseded_at IS NULL` HERE, and a mutation test holds it that way: the ask
  // fires one to four days after the activity, by which time the next discovery run has
  // routinely retired the row the parent was offered. A superseded candidate is a
  // candidate that still says which venue it was.
  const [candidate] = await database
    .select({
      placeId: schema.villageCandidates.placeId,
      civicVenueId: schema.villageCandidates.civicVenueId,
    })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.id, candidateId),
        eq(schema.villageCandidates.familyId, input.familyId),
      ),
    )
    .limit(1);
  if (!candidate) return { unresolved: 'candidate_gone' };

  // Exactly two ways a candidate yields an identity two households could share, and
  // nothing else is accepted. `place_id` first: it is Google's id for a public venue,
  // so it is the same string for every family offered it.
  if (candidate.placeId) return { source: 'place', ref: candidate.placeId };
  if (candidate.civicVenueId) return { source: 'civic_venue', ref: candidate.civicVenueId };
  return { unresolved: 'no_shared_identity' };
}
