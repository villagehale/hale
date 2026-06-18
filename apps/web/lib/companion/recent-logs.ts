import { schema } from '@hale/db';
import { desc, eq } from 'drizzle-orm';
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

/**
 * Reads the family's most recent quick-log episodes for the recent-logs section.
 * Mirrors loadCompanion's degradation: no DATABASE_URL (preview) or no resolved
 * family (unauthed / onboarding incomplete) → empty list. A genuine query
 * failure once a DB exists must surface (rule #8), so it is deliberately NOT
 * caught.
 */
export async function loadRecentLogs(): Promise<RecentLogView[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];

  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
    })
    .from(schema.familyMemoryEpisodes)
    .where(eq(schema.familyMemoryEpisodes.familyId, familyId))
    .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
    .limit(RECENT_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    childId: row.childId,
    episodeType: row.episodeType,
    summary: row.summary,
    occurredAt: row.occurredAt.toISOString(),
  }));
}
