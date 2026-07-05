'use server';

import { revalidatePath } from 'next/cache';
import { type SearchActivitiesResult, searchActivitiesForSeason } from './search';
import type { Season } from './visibility';

export type { SearchActivitiesResult };

/**
 * Server Action behind the "Find <season> activities" control on /village. A thin
 * wrapper over the shared searchActivitiesForSeason core (which owns auth, the
 * per-family rate limit, and the discovery run): on a real discovery it revalidates
 * the page so the search run's candidates render. The same core backs the mobile
 * HTTP route, so there is one spend/auth path for both surfaces.
 */
export async function searchActivitiesForSeasonAction(
  season: Season,
): Promise<SearchActivitiesResult> {
  const result = await searchActivitiesForSeason(season);
  if (result.status === 'discovered') {
    revalidatePath('/village');
  }
  return result;
}
