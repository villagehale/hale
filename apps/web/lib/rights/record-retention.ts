import { type Database, schema } from '@hale/db';
import { and, asc, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { isUndefinedTable } from '~/lib/channel/linq/roster';

/**
 * Retention for the records that had no clock of their own. Runs on the hourly
 * delete sweep beside the twelve-month message retention (message-retention.ts),
 * and like it is not behind a feature flag.
 *
 * | Table | Clock | Approach | Why |
 * | --- | --- | --- | --- |
 * | `family_memory_episodes`, removed by the parent | 30 days after `deleted_at` | BLANK `summary` and `payload`, keep `occurred_at` and `episode_type` | The soft delete keeps the row so audit rows that point at it still resolve. The words are what the parent removed, and thirty days is the erasure window the site promises. An episode's audit rows carry its time and type, not its words (companion/log-write.ts). |
 * | `proactive_candidates`, any status | 365 days after `created_at` | DELETE the row | A text Hale considered sending, kept as long as a sent message is. A settled row already holds no composed text (proactive/review.ts `mark`); its ids, codes and source link go with it. |
 * | `ack_promises` | 7 days after `claimed_at`, or after `due_at` if never claimed | DELETE the row | It holds a chat id and a message id only so one late note can be threaded. A row the flag stopped sweeping is never claimed, and is past saying a week on. A database without the table answers `not_migrated`. |
 *
 * What each clock leaves behind, decided:
 *
 * - A fact an inferencer derived from a removed episode: KEPT. A fact records no episode
 *   it came from, so the blank cannot find it. It is the household's record like any
 *   other fact, it is in the access export, and the parent can have it forgotten by name
 *   (memory/forget.ts). The inferencer stops reading the episode the moment it is
 *   removed (`episodesForContext` skips `deleted_at`).
 * - A reader that ignores `deleted_at`: NONE in production. Every reader of the table
 *   skips a removed episode or shows none of its words: export-memory.ts sends its time,
 *   type and removal date only, and timeline/replay.ts is the eval harness on its own
 *   pglite database. retention-reach.guard.test.ts lists each reader and fails on a new one.
 * - The (family_id, dedupe_key) slot a deleted candidate frees: SAFE. Most keys name a
 *   day, a week, a trip, a departure or a registration window, so no sweep writes them a
 *   year on. The weekday-care asks are keyed per prompt with no date: a year after a
 *   dropped ask Hale may weigh it once more, and a sent one stays claimed in
 *   `channel_messages`, which is never deleted and which the decider reads before any
 *   send. The same guard test lists every module that queues a candidate.
 *
 * Age is strict: a row exactly at the boundary is kept. Each table is capped at
 * {@link RECORD_RETENTION_BATCH} rows a run, and a second run is a no-op. Only
 * counts leave this function.
 */

export const REMOVED_EPISODE_RETENTION_DAYS = 30;
export const PROACTIVE_CANDIDATE_RETENTION_DAYS = 365;
export const ACK_PROMISE_RETENTION_DAYS = 7;

/** Rows handled per table per hourly run, as the message sweep's own cap. */
export const RECORD_RETENTION_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecordRetentionSummary {
  removedEpisodesBlanked: number;
  proactiveCandidatesDeleted: number;
  ackPromisesDeleted: number | 'not_migrated';
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
    ackPromisesDeleted: await deleteAgedAckPromises(
      database,
      new Date(now.getTime() - ACK_PROMISE_RETENTION_DAYS * DAY_MS),
      batch,
    ),
  };
}

async function deleteAgedAckPromises(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number | 'not_migrated'> {
  const promises = schema.ackPromises;
  try {
    const due = await database
      .select({ id: promises.id })
      .from(promises)
      .where(
        or(
          lt(promises.claimedAt, cutoff),
          and(isNull(promises.claimedAt), lt(promises.dueAt, cutoff)),
        ),
      )
      .orderBy(asc(promises.dueAt), asc(promises.id))
      .limit(batch);
    if (due.length === 0) return 0;
    const deleted = await database
      .delete(promises)
      .where(
        inArray(
          promises.id,
          due.map((row) => row.id),
        ),
      )
      .returning({ id: promises.id });
    return deleted.length;
  } catch (err) {
    if (isUndefinedTable(err)) {
      console.warn({ outcome: 'not_migrated' }, 'record retention: ack_promises is missing');
      return 'not_migrated';
    }
    throw err;
  }
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
