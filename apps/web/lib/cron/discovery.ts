import type { Database } from '@hale/db';
import type { RerankJobPayload } from '@hale/tools-contracts';
import { notifyFamilyNewPicks } from '~/lib/push/callers';
import { type BackfillResult, backfillCandidateCoords } from '~/lib/village/backfill-coords';
import {
  type DiscoverDeps,
  type DiscoverResult,
  defaultDiscoverDeps,
  discoverForFamily,
} from '~/lib/village/discover';
import { MAX_FAMILIES_PER_RUN, selectFamiliesNeedingDiscovery } from './families';

/**
 * The weekly discovery cron: for each family whose village candidates are stale
 * or empty (and that has opted into local discovery via a coarse area), run the
 * EXISTING discoverForFamily. That function is already bounded (one Anthropic
 * call per family), family-scoped, teen-excluded at the source (rule #1), and
 * writes its own audit row in the same transaction as the candidate insert (rule
 * #6) — so this orchestration adds only the per-run family cap (the budget
 * blast-radius bound) on top.
 *
 * Per-family failures don't abort the run: a model/db error for one family is
 * recorded against that family's result and the loop continues, so one bad family
 * can't starve the rest of a scheduled batch.
 */
export interface DiscoveryRunResult {
  processed: number;
  results: Array<
    { familyId: string; result: DiscoverResult } | { familyId: string; error: string }
  >;
  /** Coords backfilled this run for candidates that predate the map. */
  backfill: BackfillResult;
}

/** Minimal producer surface: enqueue a background feed-rank job for a family
 * whose candidate set just changed. Injected so the cron is unit-testable. */
export interface RerankQueue {
  send(name: string, data: RerankJobPayload): Promise<string | null>;
}

/** The new-picks push notifier, injected so the cron is unit-testable without the
 * push send path. Defaults to the real caller (which re-checks each parent's pref,
 * debounces once-per-family-per-day, and audits — rules #1/#6). */
type NewPicksNotifier = (
  familyId: string,
  newCount: number,
  database: Database,
) => Promise<unknown>;

export async function runDiscoveryCron(
  database: Database,
  deps: DiscoverDeps = defaultDiscoverDeps(),
  now: Date = new Date(),
  rerankQueue?: RerankQueue,
  notifyNewPicks: NewPicksNotifier = notifyFamilyNewPicks,
): Promise<DiscoveryRunResult> {
  const familyIds = await selectFamiliesNeedingDiscovery(
    database,
    MAX_FAMILIES_PER_RUN.discovery,
    now,
  );

  const results: DiscoveryRunResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await discoverForFamily(familyId, database, deps);
      results.push({ familyId, result });
      // New candidates change the feed's candidate set — enqueue a background
      // rerank so the home feed re-materializes OUT of the request path. The
      // upsert short-circuits an unchanged set (rule #7), so an enqueue is cheap.
      if (result.status === 'discovered' && result.insertedCount > 0) {
        if (rerankQueue) {
          await rerankQueue.send('village.rerank', { family_id: familyId });
        }
        // Tell the family's opted-in parents (coarse count + area only — rule #1),
        // at most once per family per day; a push failure must not abort the run,
        // so it's isolated from the discovery result.
        try {
          await notifyNewPicks(familyId, result.insertedCount, database);
        } catch (err) {
          console.error({ err, familyId }, 'new-picks push failed');
        }
      }
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Bounded backfill: geocode a capped batch of existing candidates that predate
  // the map so the spatial view fills in over time (rule #1: coarse area only).
  const backfill = await backfillCandidateCoords(database);

  return { processed: familyIds.length, results, backfill };
}
