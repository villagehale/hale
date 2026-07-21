'use server';

import { type CityCentroid, geocodeCanadianCity } from '~/lib/village/geocode';

/**
 * Resolve a typed area to its coarse Canadian city + centroid for the onboarding
 * location map. Deliberately PRE-AUTH: onboarding steps 1–6 are public, so this
 * cannot be auth-gated the way the switcher's searchCitiesAction is. Best-effort —
 * a miss / no key / transport error yields null and the map simply doesn't recentre.
 *
 * Privacy (rule #1): the only thing sent to Google is the coarse city text the
 * parent already types into the visible area field; the centroid comes back to the
 * client to centre a city-level map and is NEVER persisted — completeOnboarding
 * stores only {country, city}. A 2-char floor keeps single-keystroke lookups (and
 * their Places cost) from firing before there's a real query.
 */
export async function resolveCityCentroid(query: string): Promise<CityCentroid | null> {
  if (query.trim().length < 2) return null;
  return geocodeCanadianCity(query);
}
