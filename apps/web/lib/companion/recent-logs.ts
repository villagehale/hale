import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';

/** A logged episode, flattened for the recent-logs list. */
export interface RecentLogView {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  occurredAt: string;
}

const RECENT_LIMIT = 8;

/** A raw episode row this module redacts/flattens. */
interface EpisodeRow {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
}

/**
 * Rule #1: drop any episode attributed to a 13+ child. The episodes table carries
 * NO teen flag, so this list would leak a teen's quick-log summary regardless of the
 * classifier — the teen set is derived LIVE from each child's DOB (deriveStage
 * boundary 156mo), mirroring search_memory in coach/tools.ts.
 *
 * Double-miss (rule #1 "most restrictive"): an UNATTRIBUTED episode (childId null)
 * has no DOB to derive from, so it is ALSO dropped when the family has any teenager —
 * a family-wide quick-log could quote the teen. A family with no teen keeps every
 * unattributed and non-teen row (no over-redaction). Pure, no I/O.
 */
function dropTeenEpisodes(
  episodes: EpisodeRow[],
  children: ReadonlyArray<{ id: string; dateOfBirth: string }>,
  now: Date = new Date(),
): EpisodeRow[] {
  const teenChildIds = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );
  const familyHasTeen = teenChildIds.size > 0;
  return episodes.filter((e) =>
    e.childId === null ? !familyHasTeen : !teenChildIds.has(e.childId),
  );
}

/**
 * Reads the family's most recent quick-log episodes for the recent-logs section,
 * with a 13+ child's episodes dropped (rule #1, via dropTeenEpisodes). `Database`
 * and `familyId` are injected so the redaction is unit-testable without the
 * server-only auth chain; loadRecentLogs is the request wrapper.
 */
async function readRecentLogs(database: Database, familyId: string): Promise<RecentLogView[]> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
    })
    .from(schema.familyMemoryEpisodes)
    .where(
      and(
        eq(schema.familyMemoryEpisodes.familyId, familyId),
        isNull(schema.familyMemoryEpisodes.deletedAt),
      ),
    )
    .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
    .limit(RECENT_LIMIT);

  return dropTeenEpisodes(rows, children).map((row) => ({
    id: row.id,
    childId: row.childId,
    episodeType: row.episodeType,
    summary: row.summary,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

/**
 * Request wrapper. Mirrors loadCompanion's degradation: no DATABASE_URL (preview)
 * or no resolved family (unauthed / onboarding incomplete) → empty list. A genuine
 * query failure once a DB exists must surface (rule #8), so it is deliberately NOT
 * caught.
 */
export async function loadRecentLogs(): Promise<RecentLogView[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];
  return readRecentLogs(database, familyId);
}

export const _internal = { dropTeenEpisodes };
