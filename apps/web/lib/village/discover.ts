import type { Database } from '@hale/db';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { discoveryActivityClient } from '~/lib/pipeline/client';
import { findFamilyActivities, recordActivityOffers } from './live';
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
    excludePreviouslyOffered: true,
  });
  if (found.reason === 'no_area' || found.reason === 'no_non_teen_children')
    return { status: found.reason };
  if (found.reason) return { status: 'unavailable', reason: found.reason };
  const rows = await recordActivityOffers(database, familyId, found.picks);
  return {
    status: 'discovered',
    insertedCount: rows.length,
    offeredIds: rows.map((row) => row.id),
  };
}
export function defaultDiscoverDeps(): DiscoverDeps {
  return { finder: createActivityFinder(discoveryActivityClient) };
}
