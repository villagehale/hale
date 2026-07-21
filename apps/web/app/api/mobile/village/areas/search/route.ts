import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { autocompleteCanadianCities } from '~/lib/village/geocode';
import type { MobileVillageAreaSearchResponse } from '../../../types';

// Node runtime: the city search calls the Places provider over the network.
export const runtime = 'nodejs';

/**
 * GET /api/mobile/village/areas/search?q=&session= — the region switcher's typeahead:
 * Google-Maps-style fuzzy Canadian city predictions via the SAME upgraded Places
 * Autocomplete seam as the web switcher (unified — one provider, one cap). Coarse-only
 * by construction (rule #1): predictions carry no coordinates; the route returns only
 * {city, province}. Auth() is the 401 gate; the search is capped per signed-in user
 * (city-search) so the paid provider can't be reached per-keystroke without a limit.
 * Best-effort: a blank query or a provider miss yields an empty list, never a 500. The
 * optional `session` token threads a search session for one-session billing.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const limited = await enforceRateLimit('city-search', session.user.id);
  if (limited) return limited;

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const sessionToken = url.searchParams.get('session') ?? undefined;
  const predictions = await autocompleteCanadianCities(q, sessionToken);
  const cities = predictions.map(({ city, province }) => ({ city, province }));
  const body: MobileVillageAreaSearchResponse = { cities };
  return NextResponse.json(body);
}
