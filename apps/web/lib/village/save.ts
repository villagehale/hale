import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';

/**
 * The private "I'm interested" bookmark. A parent saves a village candidate for
 * later; unlike an endorsement (a public aggregate signal) a save is PRIVATE —
 * the only reader is the saving family, and saving neither enrolls the child nor
 * approves anything (rule #4). The unique (candidate_id, family_id) index makes it
 * idempotent, so this is a true TOGGLE: a first tap saves, a second unsaves.
 *
 * Saving is an action affecting the family, so BOTH directions write an immutable
 * audit_log row (rule #6) — a save and an unsave are each auditable events.
 *
 * Teen backstop (rule #1): a candidate attributed to a 13+ child must not be newly
 * saved from ANY surface — the server age-gates it deterministically (deriveStage
 * on the child's date_of_birth), not on any client-side redaction flag, so a direct
 * POST can't create a teen save the UI hides. Only the CREATE direction is blocked;
 * an UNSAVE is always allowed, so a row saved before the child turned 13 (or any
 * stuck row) can still be removed.
 */

export type ToggleSaveResult =
  | { status: 200; saved: boolean }
  | { status: 403; error: string }
  | { status: 404; error: string };

/** Validates the candidate exists and belongs to the family, then flips the save
 * state idempotently and returns the resulting `saved` boolean.
 *
 * Order mirrors endorse.ts: a missing candidate is 404; a candidate that belongs
 * to another family is 403 — save is gated to the candidate's own family so a
 * parent can't bookmark another family's discovery set. */
export async function toggleVillageSave(
  database: Database,
  args: { candidateId: string; familyId: string; userId: string },
): Promise<ToggleSaveResult> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      familyId: schema.villageCandidates.familyId,
      childId: schema.villageCandidates.childId,
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

  // Teen backstop (rule #1), deterministic on the child's date_of_birth. A teen
  // candidate can never be NEWLY saved — but an existing save may always be
  // removed, so a row saved before the child turned 13 isn't stuck. Only when the
  // candidate is teen-attributed do we take the explicit existence-check branch;
  // the common (non-teen) path keeps the single idempotent-insert toggle.
  if (await isTeenAttributed(database, candidate.childId)) {
    const existing = await database
      .select({ id: schema.villageSaves.id })
      .from(schema.villageSaves)
      .where(
        and(
          eq(schema.villageSaves.candidateId, args.candidateId),
          eq(schema.villageSaves.familyId, args.familyId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      return { status: 403, error: 'candidate_teen_redacted' };
    }
    return unsave(database, args);
  }

  const inserted = await database
    .insert(schema.villageSaves)
    .values({
      candidateId: args.candidateId,
      familyId: args.familyId,
      savedByUserId: args.userId,
    })
    .onConflictDoNothing({
      target: [schema.villageSaves.candidateId, schema.villageSaves.familyId],
    })
    .returning({ id: schema.villageSaves.id });

  // An insert that took effect = a fresh save. A conflict (0 rows) means the
  // family had already saved it, so this tap is an UNSAVE — delete the row.
  if (inserted.length > 0) {
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'village_candidate_saved',
      targetTable: 'village_candidates',
      targetId: args.candidateId,
    });
    return { status: 200, saved: true };
  }

  return unsave(database, args);
}

/** Whether a candidate is attributed to a 13+ child, derived LIVE from the child's
 * date_of_birth (deriveStage) — never a stored flag. An unattributed candidate
 * (childId null) is never teen. */
async function isTeenAttributed(
  database: Database,
  childId: string | null,
): Promise<boolean> {
  if (!childId) return false;
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.id, childId))
    .limit(1);
  const dob = rows[0]?.dateOfBirth;
  return dob !== undefined && deriveStage(dob) === 'teenager';
}

/** Deletes the family's save row and audits the unsave (rule #6, both directions). */
async function unsave(
  database: Database,
  args: { candidateId: string; familyId: string; userId: string },
): Promise<ToggleSaveResult> {
  await database
    .delete(schema.villageSaves)
    .where(
      and(
        eq(schema.villageSaves.candidateId, args.candidateId),
        eq(schema.villageSaves.familyId, args.familyId),
      ),
    );
  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.userId,
    actionTaken: 'village_candidate_unsaved',
    targetTable: 'village_candidates',
    targetId: args.candidateId,
  });
  return { status: 200, saved: false };
}

/** The set of candidate ids THIS family has saved — lets the village page mark each
 * card's bookmark state in one query instead of N. */
export async function listFamilySavedCandidateIds(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const rows = await database
    .select({ candidateId: schema.villageSaves.candidateId })
    .from(schema.villageSaves)
    .where(eq(schema.villageSaves.familyId, familyId));
  return new Set(rows.map((r) => r.candidateId));
}
