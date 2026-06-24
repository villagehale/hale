import { randomBytes } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { desc, eq } from 'drizzle-orm';

/**
 * Ensures the family's latest routine proposal carries a public share token,
 * minting one on first share. Idempotent: a proposal that already has a token is
 * returned unchanged (no write, no new audit row), so re-sharing yields the same
 * stable link.
 *
 * Returns null when the family has no proposal to share — the caller maps that
 * to a 404 rather than fabricating a token (rule #8: don't mask the empty case).
 *
 * Rule #6: minting a token is an action affecting the family, so it writes an
 * immutable audit_log row. The opaque token (randomBytes(18) → base64url) is the
 * page's only handle; it identifies no child or parent.
 */
export async function ensureShareToken(
  database: Database,
  args: { familyId: string; actorUserId: string },
): Promise<{ shareToken: string } | null> {
  const { familyId, actorUserId } = args;
  const rows = await database
    .select({
      id: schema.routineProposals.id,
      shareToken: schema.routineProposals.shareToken,
    })
    .from(schema.routineProposals)
    .where(eq(schema.routineProposals.familyId, familyId))
    .orderBy(desc(schema.routineProposals.weekOf))
    .limit(1);

  const proposal = rows[0];
  if (!proposal) {
    return null;
  }
  if (proposal.shareToken) {
    return { shareToken: proposal.shareToken };
  }

  const shareToken = randomBytes(18).toString('base64url');

  await database
    .update(schema.routineProposals)
    .set({ shareToken })
    .where(eq(schema.routineProposals.id, proposal.id));

  await database.insert(schema.auditLog).values({
    familyId,
    actor: actorUserId,
    actionTaken: 'week_plan_shared',
    targetTable: 'routine_proposals',
    targetId: proposal.id,
  });

  return { shareToken };
}

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
