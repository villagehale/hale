'use server';

import { headers } from 'next/headers';
import {
  type CityCentroid,
  type CityPrediction,
  autocompleteCanadianCities,
  resolveCityPlace,
} from '~/lib/village/geocode';
import { rateLimitStatus } from '~/lib/rate-limit/apply';

/**
 * The onboarding step-4 city typeahead, PRE-AUTH (steps 1–6 are public), so it can't
 * be auth-gated the way the switcher's searchCitiesAction is. Rate-limited per CLIENT
 * IP against the paid Places provider (rule: no uncapped provider route); the limiter
 * fails open, so a preview without a DB simply proceeds. A search session's token is
 * threaded through autocomplete + the details call so Google bills them as one
 * session.
 *
 * Privacy (rule #1): only the coarse city text the parent types is sent; the centroid
 * that comes back centres a city-level map and is never persisted — completeOnboarding
 * stores only {country, city}.
 */

export type CityAutocompleteResult =
  | { status: 'ok'; predictions: CityPrediction[] }
  | { status: 'rate_limited' };

export type CityResolveResult =
  | { status: 'ok'; centroid: CityCentroid | null }
  | { status: 'rate_limited' };

/** The client IP for the pre-auth caller (the only identifier available before
 * sign-in). Mirrors clientIp() in the rate-limit module: first x-forwarded-for hop,
 * or a fixed key so a header-less call is still capped rather than free. */
async function clientIdentifier(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

export async function autocompleteCityAction(
  input: string,
  sessionToken: string,
): Promise<CityAutocompleteResult> {
  // A 2-char floor keeps single-keystroke lookups (and their Places cost) from firing.
  if (input.trim().length < 2) return { status: 'ok', predictions: [] };
  const { allowed } = await rateLimitStatus('city-search', await clientIdentifier());
  if (!allowed) return { status: 'rate_limited' };
  return { status: 'ok', predictions: await autocompleteCanadianCities(input, sessionToken) };
}

export async function resolveCityAction(
  placeId: string,
  sessionToken: string,
): Promise<CityResolveResult> {
  if (!placeId.trim()) return { status: 'ok', centroid: null };
  const { allowed } = await rateLimitStatus('city-search', await clientIdentifier());
  if (!allowed) return { status: 'rate_limited' };
  return { status: 'ok', centroid: await resolveCityPlace(placeId, sessionToken) };
}
