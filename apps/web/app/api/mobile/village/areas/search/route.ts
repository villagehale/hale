import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { searchCanadianCities } from '~/lib/village/geocode';
import type { MobileVillageAreaSearchResponse } from '../../../types';

// Node runtime: the city search calls the Places provider over the network.
export const runtime = 'nodejs';

/**
 * GET /api/mobile/village/areas/search?q= — the region switcher's typeahead: up to
 * 6 Canadian city candidates {city, province} for the query, via the SAME Places
 * provider as venue geocoding (reuse, not a new provider). Coarse-only by
 * construction (rule #1) — the search requests no coordinate field and returns
 * none. Best-effort: a blank query or a provider miss/error yields an empty list,
 * never a 500. Auth() is the 401 gate.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const q = new URL(req.url).searchParams.get('q') ?? '';
  const cities = await searchCanadianCities(q);
  const body: MobileVillageAreaSearchResponse = { cities };
  return NextResponse.json(body);
}
