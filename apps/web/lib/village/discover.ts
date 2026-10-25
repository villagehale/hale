import type { Database } from '@hale/db';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { discoveryActivityClient } from '~/lib/pipeline/client';
import {
  activityRecommendationKey,
  findFamilyActivities,
  offeredReceiptIdsByKey,
  recordActivityOffers,
} from './live';
import type { Season } from './visibility';

export interface DiscoverDeps {
  finder: ActivityFinder;
}
export interface DiscoverOptions {
  searchSeason?: Season;
  subject?: string;
}
export type DiscoverResult =
  | { status: 'discovered'; insertedCount: number; offeredIds: string[] }
  | { status: 'no_area' }
  | { status: 'no_non_teen_children' }
  | { status: 'unavailable'; reason: string };

/** On-demand live research. Stored rows are offer receipts, not tomorrow's feed. */
export async function discoverForFamily(
  familyId: string,
  database: Database,
  deps: DiscoverDeps = defaultDiscoverDeps(),
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const found = await findFamilyActivities(database, familyId, {
    finder: deps.finder,
    subject: options.subject,
    window: options.searchSeason ? `this coming ${options.searchSeason}` : 'this year',
    // VIL-451 · a PARENT-INITIATED read shows every current live result, including ones
    // offered before. Proactive suppression lives with the proactive callers
    // (readCandidates), not here.
    excludePreviouslyOffered: false,
  });
  if (found.reason === 'no_area' || found.reason === 'no_non_teen_children')
    return { status: found.reason };
  if (found.reason) return { status: 'unavailable', reason: found.reason };
  // Reuse the existing receipt for an activity already offered (saved state and
  // receipt identity survive); write a new receipt only for a genuinely new one.
  const existing = await offeredReceiptIdsByKey(database, familyId);
  const offeredIds: string[] = [];
  const fresh: typeof found.picks = [];
  const seen = new Set<string>();
  for (const pick of found.picks) {
    const key = activityRecommendationKey(pick);
    if (key !== null && seen.has(key)) continue;
    if (key !== null) seen.add(key);
    const id = key === null ? undefined : existing.get(key);
    if (id) offeredIds.push(id);
    else fresh.push(pick);
  }
  const rows = await recordActivityOffers(database, familyId, fresh);
  offeredIds.push(...rows.map((row) => row.id));
  return {
    status: 'discovered',
    insertedCount: rows.length,
    offeredIds,
  };
}
export function defaultDiscoverDeps(): DiscoverDeps {
  return { finder: createActivityFinder(discoveryActivityClient) };
}
