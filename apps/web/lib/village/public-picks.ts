import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { type PublicActivity, type PublicCandidateRow, toPublicActivity } from './public.js';

/**
 * The PUBLIC, unauthenticated "village picks" artifact (rule #1): a family's
 * ENDORSED local recommendations as a shareable shortlist. It reuses the SAME
 * privacy contract as the week plan (`/w`):
 *   - resolves a `routine_proposals.shareToken` to a family + coarse area;
 *   - NEVER joins `children` — only family-wide candidates (childId IS NULL) are
 *     even queryable, so a teen/child leak is impossible by construction;
 *   - projects survivors through the shared `toPublicActivity` allow-list
 *     (title/kind/summary/sourceUrl/coverageNote + aggregate count).
 *
 * The difference from the week plan: picks are restricted to candidates THIS
 * family has endorsed (an inner join to village_endorsements on the family),
 * so the artifact is the trusted, parent-curated shortlist — the hybrid-trust
 * signal made shareable.
 */
export interface PublicPicks {
  /** Coarse area (FSA / city) or null when the family opted out. Never precise. */
  areaCoarse: string | null;
  activities: PublicActivity[];
}

/** A picks share surfaces at most this many endorsed candidates. */
const PUBLIC_PICKS_LIMIT = 24;

export async function loadSharedPicks(
  token: string,
  database: Database,
): Promise<PublicPicks | null> {
  const proposalRows = await database
    .select({
      familyId: schema.routineProposals.familyId,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.routineProposals)
    .innerJoin(schema.families, eq(schema.families.id, schema.routineProposals.familyId))
    .where(eq(schema.routineProposals.shareToken, token))
    .limit(1);

  const proposal = proposalRows[0];
  if (!proposal) {
    return null;
  }

  const rows = await database
    .select({
      childId: schema.villageCandidates.childId,
      title: schema.villageCandidates.title,
      kind: schema.villageCandidates.kind,
      summary: schema.villageCandidates.summary,
      sourceUrl: schema.villageCandidates.sourceUrl,
      coverageNote: schema.villageCandidates.coverageNote,
      endorsementCount: sql<number>`(
        select count(*)::int from ${schema.villageEndorsements}
        where ${schema.villageEndorsements.candidateId} = ${schema.villageCandidates.id}
      )`,
    })
    .from(schema.villageCandidates)
    .innerJoin(
      schema.villageEndorsements,
      eq(schema.villageEndorsements.candidateId, schema.villageCandidates.id),
    )
    .where(
      and(
        eq(schema.villageCandidates.familyId, proposal.familyId),
        eq(schema.villageEndorsements.familyId, proposal.familyId),
        // Family-wide only — the public allow-list never surfaces a child-linked
        // row. Enforced in SQL AND again in the mapper (defence in depth).
        isNull(schema.villageCandidates.childId),
      ),
    )
    .orderBy(desc(schema.villageCandidates.discoveredAt))
    .limit(PUBLIC_PICKS_LIMIT);

  const activities = (rows as PublicCandidateRow[])
    .filter((candidate) => candidate.childId === null)
    .map(toPublicActivity);

  return { areaCoarse: proposal.areaCoarse, activities };
}
