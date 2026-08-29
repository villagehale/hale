import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { desc, eq } from 'drizzle-orm';

export type ActivityShareResult =
  | { shareToken: string }
  | { error: 'candidate_not_found' }
  | { error: 'candidate_belongs_to_another_family' };

/**
 * Ensures a single village candidate carries a public share token for its own
 * shareable card (`/a/:token`), minting one on first share. Idempotent: a
 * candidate that already has a token returns it unchanged (no write, no new
 * audit row), so re-sharing yields the same stable link.
 *
 * Ownership-gated exactly like accept (rule #1/#4): a missing candidate → 404, a
 * candidate of another family → 403, so a parent can only mint links for their
 * own family's picks. The first mint writes an immutable audit_log row (rule #6).
 * The opaque token identifies no child or parent.
 */
export async function ensureActivityShareToken(
  database: Database,
  args: { candidateId: string; familyId: string; actorUserId: string },
): Promise<ActivityShareResult> {
  const { candidateId, familyId, actorUserId } = args;
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      familyId: schema.villageCandidates.familyId,
      childId: schema.villageCandidates.childId,
      shareToken: schema.villageCandidates.shareToken,
    })
    .from(schema.villageCandidates)
    .where(eq(schema.villageCandidates.id, candidateId))
    .limit(1);

  const candidate = rows[0];
  if (!candidate) {
    return { error: 'candidate_not_found' };
  }
  if (candidate.familyId !== familyId) {
    return { error: 'candidate_belongs_to_another_family' };
  }
  // A child-attributed candidate can never be made public (rule #1) — refuse to
  // mint a token for it, the same fail-closed posture the loader uses.
  if (candidate.childId !== null) {
    return { error: 'candidate_belongs_to_another_family' };
  }
  if (candidate.shareToken) {
    return { shareToken: candidate.shareToken };
  }

  const shareToken = randomBytes(18).toString('base64url');

  await database
    .update(schema.villageCandidates)
    .set({ shareToken })
    .where(eq(schema.villageCandidates.id, candidate.id));

  await database.insert(schema.auditLog).values({
    familyId,
    actor: actorUserId,
    actionTaken: 'village_activity_shared',
    targetTable: 'village_candidates',
    targetId: candidate.id,
  });

  return { shareToken };
}
