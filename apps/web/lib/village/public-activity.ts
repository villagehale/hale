import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { type PublicActivity, type PublicCandidateRow, toPublicActivity } from './public.js';

/**
 * The PUBLIC, unauthenticated single-activity share card (rule #1): one endorsed
 * recommendation as a shareable page (`/a/:token`). Same privacy contract as the
 * week plan and picks:
 *   - resolves a per-candidate `family_activity_history.shareToken` to its row;
 *   - NEVER joins `children`;
 *   - FAILS CLOSED on a child-attributed candidate. A single row can't be
 *     "filtered out" like a list, so a candidate with a non-null childId returns
 *     null (404) rather than surfacing — a teen/child leak is impossible.
 *   - projects through the shared `toPublicActivity` allow-list.
 */
export interface PublicActivityCard {
  /** Coarse area (FSA / city) or null when the family opted out. Never precise. */
  areaCoarse: string | null;
  activity: PublicActivity;
}

export async function loadSharedActivity(
  token: string,
  database: Database,
): Promise<PublicActivityCard | null> {
  const rows = await database
    .select({
      childId: schema.familyActivityHistory.childId,
      title: schema.familyActivityHistory.title,
      kind: schema.familyActivityHistory.kind,
      summary: schema.familyActivityHistory.summary,
      sourceUrl: schema.familyActivityHistory.sourceUrl,
      coverageNote: schema.familyActivityHistory.coverageNote,
      offeredAt: schema.familyActivityHistory.offeredAt,
      areaCoarse: schema.families.areaCoarse,
      endorsementCount: sql<number>`(
        select count(*)::int from ${schema.villageEndorsements}
        where ${schema.villageEndorsements.candidateId} = ${schema.familyActivityHistory.id}
      )`,
    })
    .from(schema.familyActivityHistory)
    .innerJoin(schema.families, eq(schema.families.id, schema.familyActivityHistory.familyId))
    .where(eq(schema.familyActivityHistory.shareToken, token))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }
  // Fail closed: a child-attributed single candidate is never public (rule #1).
  if (row.childId !== null) {
    return null;
  }

  const activity = toPublicActivity({
    ...row,
    summary: row.offeredAt
      ? `Snapshot from ${row.offeredAt.toISOString().slice(0, 10)}; confirm current details at the source.\n${row.summary}`
      : 'Shared from an earlier find. Check their page for current dates and availability.',
  } as PublicCandidateRow);
  return { areaCoarse: row.areaCoarse, activity };
}
