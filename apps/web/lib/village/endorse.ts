import { type Database, schema } from '@hale/db';
import { and, count, eq, inArray } from 'drizzle-orm';

/**
 * Hybrid trust (AI-sourced discovery + parent-endorsed). A parent endorses a
 * village candidate; the only thing ever surfaced is an AGGREGATE count of
 * DISTINCT families — never a family's identity (rule #1). The unique
 * (candidate_id, family_id) index makes endorsing idempotent, so re-tapping is a
 * no-op and the count is a true distinct-family count.
 *
 * Endorsing is an action affecting the family, so the FIRST endorsement writes an
 * immutable audit_log row (rule #6). A duplicate (already endorsed) writes
 * nothing new — no double audit row, no double count.
 */

export type EndorseResult =
  | { status: 200; count: number; alreadyEndorsed: boolean }
  | { status: 403; error: string }
  | { status: 404; error: string };

/** Validates the candidate exists and belongs to the family, then records the
 * endorsement idempotently and returns the fresh distinct-family count.
 *
 * Order matters (mirrors accept.ts): a missing candidate is 404; a candidate
 * that belongs to another family is 403 — endorse is gated to the candidate's
 * own family, so a parent can't pad another family's social proof. */
export async function endorseVillageCandidate(
  database: Database,
  args: { candidateId: string; familyId: string; userId: string },
): Promise<EndorseResult> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      familyId: schema.villageCandidates.familyId,
    })
    .from(schema.villageCandidates)
    .where(eq(schema.villageCandidates.id, args.candidateId))
    .limit(1);

  const candidate = rows[0];
  if (!candidate) {
    return { status: 404, error: 'candidate_not_found' };
  }
  if (candidate.familyId !== args.familyId) {
    return { status: 403, error: 'candidate_belongs_to_another_family' };
  }

  const inserted = await database
    .insert(schema.villageEndorsements)
    .values({
      candidateId: args.candidateId,
      familyId: args.familyId,
      endorsedByUserId: args.userId,
    })
    .onConflictDoNothing({
      target: [schema.villageEndorsements.candidateId, schema.villageEndorsements.familyId],
    })
    .returning({ id: schema.villageEndorsements.id });

  const alreadyEndorsed = inserted.length === 0;

  if (!alreadyEndorsed) {
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'village_candidate_endorsed',
      targetTable: 'village_candidates',
      targetId: args.candidateId,
    });
  }

  const freshCount = await countEndorsementsForCandidate(database, args.candidateId);
  return { status: 200, count: freshCount, alreadyEndorsed };
}

/** Distinct-family endorsement count for one candidate. */
export async function countEndorsementsForCandidate(
  database: Database,
  candidateId: string,
): Promise<number> {
  const rows = await database
    .select({ value: count() })
    .from(schema.villageEndorsements)
    .where(eq(schema.villageEndorsements.candidateId, candidateId));
  return rows[0]?.value ?? 0;
}

/**
 * Endorsement counts for many candidates in one query, returned as a map of
 * candidateId → count. Candidates with no endorsements are simply absent (the
 * caller treats absent as 0). An empty input short-circuits to avoid an
 * `IN ()` query.
 */
export async function countEndorsementsForCandidates(
  database: Database,
  candidateIds: string[],
): Promise<Map<string, number>> {
  if (candidateIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({
      candidateId: schema.villageEndorsements.candidateId,
      value: count(),
    })
    .from(schema.villageEndorsements)
    .where(inArray(schema.villageEndorsements.candidateId, candidateIds))
    .groupBy(schema.villageEndorsements.candidateId);

  return new Map(rows.map((r) => [r.candidateId, r.value]));
}

/** Whether THIS family has already endorsed a candidate — drives the button's
 * "endorsed" state so the parent sees their own tap reflected. */
export async function hasFamilyEndorsed(
  database: Database,
  args: { candidateId: string; familyId: string },
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.villageEndorsements.id })
    .from(schema.villageEndorsements)
    .where(
      and(
        eq(schema.villageEndorsements.candidateId, args.candidateId),
        eq(schema.villageEndorsements.familyId, args.familyId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The set of candidate ids THIS family has endorsed — lets the village page
 * mark each card's button state in one query instead of N. */
export async function listFamilyEndorsedCandidateIds(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const rows = await database
    .select({ candidateId: schema.villageEndorsements.candidateId })
    .from(schema.villageEndorsements)
    .where(eq(schema.villageEndorsements.familyId, familyId));
  return new Set(rows.map((r) => r.candidateId));
}
