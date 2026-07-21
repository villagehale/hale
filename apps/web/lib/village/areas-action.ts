'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import { rateLimitStatus } from '~/lib/rate-limit/apply';
import { addArea, setActiveArea } from './areas';
import {
  type CityCentroid,
  type CityPrediction,
  autocompleteCanadianCities,
  resolveCityPlace,
} from './geocode';

/**
 * Server Actions behind the top-bar location switcher (design handoff §3.2). They
 * wrap the shared, already-tested areas lib (which owns family-scoping, the
 * coordinate refusal — rule #1 — and the audit rows — rule #6), so the web and
 * mobile surfaces share one write path. The (authed) layout is force-dynamic, so
 * after a switch the client calls router.refresh() to re-render the location pill +
 * area-derived content; revalidatePath('/village') additionally drops any cached
 * village render.
 */

export type SwitchAreaResult = { status: 'ok' } | { status: 'error'; error: string };

/** The switcher's typeahead — Google-Maps-style fuzzy predictions restricted to
 * Canadian cities (rule #1: predictions carry no coordinates). Auth-gated and capped
 * per user against the paid Places provider; over the cap or a blank query yields [].
 * Pass the search session's token so autocomplete + resolveCityAction bill as one
 * session. Returns an ARRAY (CityPrediction extends the old {city, province}) so
 * existing switcher consumers stay source-compatible. */
export async function searchCitiesAction(
  query: string,
  sessionToken?: string,
): Promise<CityPrediction[]> {
  const session = await auth();
  if (!session?.user?.id) return [];
  const { allowed } = await rateLimitStatus('city-search', session.user.id);
  if (!allowed) return [];
  return autocompleteCanadianCities(query, sessionToken);
}

/** Resolve a selected prediction to its coarse {city, province, centroid} via Place
 * Details (rule #1: centroid = city centre, never persisted). Auth-gated + capped per
 * user; over the cap or a miss yields null. Same session token as searchCitiesAction
 * closes the billed session. */
export async function resolveCityAction(
  placeId: string,
  sessionToken?: string,
): Promise<CityCentroid | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { allowed } = await rateLimitStatus('city-search', session.user.id);
  if (!allowed) return null;
  return resolveCityPlace(placeId, sessionToken);
}

async function resolveScope() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) return null;
  const userId = await resolveUserIdForUser(session.user.id, database);
  if (!userId) return null;
  return { database, familyId, userId };
}

function revalidateAreaSurfaces() {
  revalidatePath('/village');
  revalidatePath('/home');
}

/**
 * Picking a searched city fully relocates the family (design handoff Interactions):
 * add the coarse area (deduped by the lib), then activate it. The pill + every
 * "Near you" surface follow.
 */
export async function relocateToCityAction(input: {
  city: string;
  province?: string | null;
}): Promise<SwitchAreaResult> {
  const scope = await resolveScope();
  if (!scope) return { status: 'error', error: 'unauthorized' };

  const added = await addArea(scope.database, {
    familyId: scope.familyId,
    userId: scope.userId,
    input: { city: input.city, province: input.province ?? undefined },
  });
  if (added.status === 'cap_reached') return { status: 'error', error: 'cap_reached' };
  if (added.status === 'invalid') return { status: 'error', error: added.error };

  const activated = await setActiveArea(scope.database, {
    familyId: scope.familyId,
    userId: scope.userId,
    areaId: added.area.id,
  });
  if (activated.status === 'not_found') return { status: 'error', error: 'not_found' };

  revalidateAreaSurfaces();
  return { status: 'ok' };
}

/** Picking a saved area just activates it. */
export async function activateAreaAction(areaId: string): Promise<SwitchAreaResult> {
  const scope = await resolveScope();
  if (!scope) return { status: 'error', error: 'unauthorized' };

  const activated = await setActiveArea(scope.database, {
    familyId: scope.familyId,
    userId: scope.userId,
    areaId,
  });
  if (activated.status === 'not_found') return { status: 'error', error: 'not_found' };

  revalidateAreaSurfaces();
  return { status: 'ok' };
}
