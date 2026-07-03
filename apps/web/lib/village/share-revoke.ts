import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

/**
 * The "links you have shared" list and its Revoke action (rule #1, #6). A share
 * token is the ONLY handle to a public artifact; the schema makes it revocable by
 * construction — the column is nullable, and every public loader resolves
 * `WHERE share_token = :token`, so nulling it makes the token resolve nothing and
 * the public page falls to its calm "no longer active" state. Revoke is therefore
 * a single UPDATE to NULL, family-scoped, writing one immutable audit row (rule #6).
 *
 * Two token-bearing tables carry a shareable link:
 *   - routine_proposals.share_token  → the week plan (/w) AND picks (/picks) share
 *     one token, so revoking it turns off BOTH views at once.
 *   - village_candidates.share_token → one endorsed activity card (/a).
 * A link is addressed by (kind, id); kind selects the table so the two never mix.
 */

export type ShareLinkKind = 'week_plan' | 'activity';

export interface SharedLink {
  kind: ShareLinkKind;
  /** The owning row's id (routine_proposals.id or village_candidates.id). */
  id: string;
  token: string;
  /** A human label for the list — the week's date, or the activity's title. */
  title: string;
}

/**
 * Lists the family's currently-live shared links (token IS NOT NULL), newest first.
 * Family-scoped (rule #1): only the requesting family's own rows are ever returned.
 * A revoked link (token nulled) drops out of this list by the same predicate.
 */
export async function listSharedLinks(
  database: Database,
  familyId: string,
): Promise<SharedLink[]> {
  const [weekPlans, activities] = await Promise.all([
    database
      .select({ id: schema.routineProposals.id, token: schema.routineProposals.shareToken, weekOf: schema.routineProposals.weekOf })
      .from(schema.routineProposals)
      .where(
        and(
          eq(schema.routineProposals.familyId, familyId),
          isNotNull(schema.routineProposals.shareToken),
        ),
      )
      .orderBy(desc(schema.routineProposals.weekOf)),
    database
      .select({ id: schema.villageCandidates.id, token: schema.villageCandidates.shareToken, title: schema.villageCandidates.title })
      .from(schema.villageCandidates)
      .where(
        and(
          eq(schema.villageCandidates.familyId, familyId),
          isNotNull(schema.villageCandidates.shareToken),
        ),
      )
      .orderBy(desc(schema.villageCandidates.discoveredAt)),
  ]);

  const weekLinks: SharedLink[] = weekPlans
    // token is guaranteed non-null by the query predicate; narrow for the type.
    .filter((r): r is typeof r & { token: string } => r.token !== null)
    .map((r) => ({ kind: 'week_plan', id: r.id, token: r.token, title: `week of ${r.weekOf}` }));

  const activityLinks: SharedLink[] = activities
    .filter((r): r is typeof r & { token: string } => r.token !== null)
    .map((r) => ({ kind: 'activity', id: r.id, token: r.token, title: r.title }));

  return [...weekLinks, ...activityLinks];
}

/**
 * Revokes ONE shared link the family owns: nulls the token, family-scoped, and
 * writes one immutable audit row (rule #6). Returns true when a live link was
 * revoked; false when no live (token-bearing) row with that id belongs to the
 * family (unknown id, foreign family, or already revoked) — no write, no audit row.
 * The `before` snapshot preserves the revoked token for the audit trail.
 */
export async function revokeShareLink(
  database: Database,
  args: { kind: ShareLinkKind; id: string; familyId: string; actorUserId: string },
): Promise<boolean> {
  const { kind, id, familyId, actorUserId } = args;

  if (kind === 'week_plan') {
    const revoked = await database
      .update(schema.routineProposals)
      .set({ shareToken: null })
      .where(
        and(
          eq(schema.routineProposals.id, id),
          eq(schema.routineProposals.familyId, familyId),
          isNotNull(schema.routineProposals.shareToken),
        ),
      )
      .returning({ token: schema.routineProposals.shareToken });
    return recordRevoke(database, revoked, {
      familyId,
      actorUserId,
      targetTable: 'routine_proposals',
      targetId: id,
    });
  }

  const revoked = await database
    .update(schema.villageCandidates)
    .set({ shareToken: null })
    .where(
      and(
        eq(schema.villageCandidates.id, id),
        eq(schema.villageCandidates.familyId, familyId),
        isNotNull(schema.villageCandidates.shareToken),
      ),
    )
    .returning({ token: schema.villageCandidates.shareToken });
  return recordRevoke(database, revoked, {
    familyId,
    actorUserId,
    targetTable: 'village_candidates',
    targetId: id,
  });
}

/**
 * Writes the audit row for a revoke when the UPDATE actually changed a row. The
 * returning() is empty when nothing matched (unknown/foreign/already-revoked), so
 * no audit row is written for a no-op — false bubbles to a 404 at the route.
 */
async function recordRevoke(
  database: Database,
  revoked: Array<{ token: string | null }>,
  audit: { familyId: string; actorUserId: string; targetTable: string; targetId: string },
): Promise<boolean> {
  if (revoked.length === 0) {
    return false;
  }
  await database.insert(schema.auditLog).values({
    familyId: audit.familyId,
    actor: audit.actorUserId,
    actionTaken: 'share_link_revoked',
    targetTable: audit.targetTable,
    targetId: audit.targetId,
    after: { shareToken: null },
  });
  return true;
}
