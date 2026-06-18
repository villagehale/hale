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
