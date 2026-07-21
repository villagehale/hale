'use server';

import { headers } from 'next/headers';
import { rateLimitStatus } from '~/lib/rate-limit/apply';
import { type CityCentroid, resolveCityPlace } from '~/lib/village/geocode';

/**
 * The onboarding step-4 city SELECTION action, PRE-AUTH (steps 1–6 are public), so it
 * can't be auth-gated the way the switcher's action is. The typeahead itself is served
 * from GET /api/onboarding/city-search (a route handler, so debounced keystroke lookups
 * parallelize instead of serializing behind each other — WP-12); resolving a PICKED
 * place stays a Server Action here, since a selection is a single call, not a stream.
 *
 * Rate-limited per CLIENT IP against the paid Places provider (rule: no uncapped
 * provider route); the limiter fails open, so a preview without a DB simply proceeds.
 * The session token threads autocomplete + this details call so Google bills them as
 * one session.
 *
 * Privacy (rule #1): only the coarse city text the parent typed is sent; the centroid
 * that comes back centres a city-level map and is never persisted — completeOnboarding
 * stores only {country, city}.
 */

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

export async function resolveCityAction(
  placeId: string,
  sessionToken: string,
): Promise<CityResolveResult> {
  if (!placeId.trim()) return { status: 'ok', centroid: null };
  const { allowed } = await rateLimitStatus('city-search', await clientIdentifier());
  if (!allowed) return { status: 'rate_limited' };
  return { status: 'ok', centroid: await resolveCityPlace(placeId, sessionToken) };
}
