import { type Database, schema } from '@hale/db';
import type { RerankQueue } from '~/lib/cron/discovery';

/**
 * One-time backfill: enqueue a village.rerank job for EVERY family so existing
 * families (who predate the materialized feed rank) get a stored order on the
 * next drain. Idempotent and bounded-spend by construction — upsertFeedRank
 * short-circuits an unchanged candidate set and skips families with <2 candidates
 * (rule #7), so re-running this enqueues cheap no-ops, never a wave of model
 * calls. NOT wired to a cron or request path; invoke it deliberately once (e.g.
 * from a one-off script or `node -e`), then let the every-minute drain consume.
 */
export async function backfillFeedRanks(
  database: Database,
  queue: RerankQueue,
): Promise<{ enqueued: number }> {
  const families = await database.select({ id: schema.families.id }).from(schema.families);
  for (const { id } of families) {
    await queue.send('village.rerank', { family_id: id });
  }
  return { enqueued: families.length };
}
