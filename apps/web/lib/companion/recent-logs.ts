import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';

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
 * Rule #1 teen redaction, with the parent-authored exemption (policy 2). The
 * episodes table carries no teen flag, so the teen set is derived LIVE from each
 * child's DOB (deriveStage boundary 156mo), mirroring search_memory.
 *
 * A row is EXEMPT — always kept — when the REQUESTING parent authored it
 * (`authoredBy === requestingUserId`): a parent's own log about their 13+ teen is
 * the parent's own content, not the teen's, so it must survive for its author
 * (never confirmed "kept" then silently dropped). Quick-logs are the only writer of
 * this table today, so a parent's own logs — attributed to the teen or family-wide
 * — are theirs to see.
 *
 * Otherwise: a row attributed to a teen child is the teen's own content → dropped.
 * An UNATTRIBUTED row (childId null) the requester did NOT author has no DOB to
 * derive from and could quote the teen, so the rule-#1 "most restrictive" default
 * drops it when the family has any teenager. A family with no teen keeps everything.
 * Pure, no I/O.
 */
function dropTeenEpisodes<T extends { childId: string | null; authoredBy: string | null }>(
  episodes: T[],
  children: ReadonlyArray<{ id: string; dateOfBirth: string }>,
  requestingUserId: string | null,
  now: Date = new Date(),
): T[] {
  const teenChildIds = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );
  const familyHasTeen = teenChildIds.size > 0;
  return episodes.filter((e) => {
    if (requestingUserId !== null && e.authoredBy === requestingUserId) return true;
    if (e.childId === null) return !familyHasTeen;
    return !teenChildIds.has(e.childId);
  });
}

/**
 * Reads the family's most recent quick-log episodes for the recent-logs section,
 * with a 13+ child's episodes dropped (rule #1, via dropTeenEpisodes). `Database`
 * and `familyId` are injected so the redaction is unit-testable without the
 * server-only auth chain; loadRecentLogs is the request wrapper.
 */
async function readRecentLogs(
  database: Database,
  familyId: string,
  requestingUserId: string | null,
): Promise<RecentLogView[]> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      authoredBy: schema.familyMemoryEpisodes.authoredBy,
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

  return dropTeenEpisodes(rows, children, requestingUserId).map((row) => ({
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
  const requestingUserId = await currentUserId(database);
  return readRecentLogs(database, familyId, requestingUserId);
}

export const _internal = { dropTeenEpisodes };
