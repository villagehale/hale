import { type Database, schema } from '@hale/db';
import { and, asc, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';

/**
 * Retention for two records that had no clock of their own. Runs on the hourly
 * delete sweep beside the twelve-month message retention (message-retention.ts),
 * and like it is not behind a feature flag.
 *
 * | Table | Clock | Approach | Why |
 * | --- | --- | --- | --- |
 * | `family_memory_episodes`, removed by the parent | 30 days after `deleted_at` | BLANK `summary` and `payload`, keep `occurred_at` and `episode_type` | The soft delete keeps the row so audit rows that point at it still resolve. The words are what the parent removed, and thirty days is the erasure window the site promises. An episode's audit rows carry its time and type, not its words (companion/log-write.ts). |
 * | `proactive_candidates`, any status | 365 days after `created_at` | DELETE the row | A text Hale considered sending, kept as long as a sent message is. A settled row already holds no composed text (proactive/review.ts `mark`); its ids, codes and source link go with it. Every queued key names a day, a week, a trip, an offer or a registration window, so a year-old key is not one a sweep still writes. |
 *
 * Age is strict: a row exactly at the boundary is kept. Each table is capped at
 * {@link RECORD_RETENTION_BATCH} rows a run, and a second run is a no-op. Only
 * counts leave this function.
 */

export const REMOVED_EPISODE_RETENTION_DAYS = 30;
export const PROACTIVE_CANDIDATE_RETENTION_DAYS = 365;

/** Rows handled per table per hourly run, as the message sweep's own cap. */
export const RECORD_RETENTION_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordRetentionSummary {
  removedEpisodesBlanked: number;
  proactiveCandidatesDeleted: number;
}

export async function sweepRecordRetention(
  database: Database,
  now: Date = new Date(),
  options: { batchSize?: number } = {},
): Promise<RecordRetentionSummary> {
  const batch = options.batchSize ?? RECORD_RETENTION_BATCH;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new Error('sweepRecordRetention: batchSize must be a positive integer');
  }
  return {
    removedEpisodesBlanked: await blankRemovedEpisodes(
      database,
      new Date(now.getTime() - REMOVED_EPISODE_RETENTION_DAYS * DAY_MS),
      batch,
    ),
    proactiveCandidatesDeleted: await deleteAgedCandidates(
      database,
      new Date(now.getTime() - PROACTIVE_CANDIDATE_RETENTION_DAYS * DAY_MS),
      batch,
    ),
  };
}

async function blankRemovedEpisodes(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const episodes = schema.familyMemoryEpisodes;
  const due = await database
    .select({ id: episodes.id })
    .from(episodes)
    .where(
      and(
        isNotNull(episodes.deletedAt),
        lt(episodes.deletedAt, cutoff),
        or(ne(episodes.summary, ''), sql`${episodes.payload} <> '{}'::jsonb`),
      ),
    )
    .orderBy(asc(episodes.deletedAt), asc(episodes.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(episodes)
    .set({ summary: '', payload: {} })
    .where(
      inArray(
        episodes.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: episodes.id });
  return updated.length;
}

async function deleteAgedCandidates(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const candidates = schema.proactiveCandidates;
  const due = await database
    .select({ id: candidates.id })
    .from(candidates)
    .where(lt(candidates.createdAt, cutoff))
    .orderBy(asc(candidates.createdAt), asc(candidates.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const deleted = await database
    .delete(candidates)
    .where(
      inArray(
        candidates.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: candidates.id });
  return deleted.length;
}
