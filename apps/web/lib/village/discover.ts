import type { Database } from '@hale/db';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { discoveryActivityClient } from '~/lib/pipeline/client';
import {
  findFamilyActivities,
  offerReceiptKey,
  offeredReceiptIdsByKey,
  recordActivityOffers,
  refreshActivityOffers,
  withSourceUrl,
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
  // VIL-451 · reuse the existing receipt for an activity already offered (saved
  // state and receipt identity survive) but refresh its facts from this live read;
  // write a new receipt only for a genuinely new one. offeredIds keep the live
  // ranking order.
  const existing = await offeredReceiptIdsByKey(database, familyId);
  const slots: ({ id: string } | { fresh: number })[] = [];
  const fresh: typeof found.picks = [];
  const refreshes: { id: string; pick: (typeof found.picks)[number] }[] = [];
  const seen = new Set<string>();
  for (const raw of found.picks) {
    const pick = withSourceUrl(raw);
    const key = offerReceiptKey(pick);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = existing.get(key);
    if (id) {
      refreshes.push({ id, pick });
      slots.push({ id });
    } else {
      slots.push({ fresh: fresh.length });
      fresh.push(pick);
    }
  }
  await refreshActivityOffers(database, familyId, refreshes);
  const rows = await recordActivityOffers(database, familyId, fresh);
  const offeredIds = slots.flatMap((slot) => {
    if ('id' in slot) return [slot.id];
    const row = rows[slot.fresh];
    return row ? [row.id] : [];
  });
  return {
    status: 'discovered',
    insertedCount: rows.length,
    offeredIds,
  };
}
export function defaultDiscoverDeps(): DiscoverDeps {
  return { finder: createActivityFinder(discoveryActivityClient) };
}
