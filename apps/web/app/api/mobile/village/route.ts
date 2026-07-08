import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadCuratedResources } from '~/lib/village/curated-resources';
import { loadVillage } from '~/lib/village/queries';
import { SEASONS, type Season } from '~/lib/village/visibility';
import type { MobileVillageResponse } from '../types';

export const runtime = 'nodejs';

function seasonParam(req: Request): Season | null {
  const raw = new URL(req.url).searchParams.get('season');
  return raw && (SEASONS as readonly string[]).includes(raw) ? (raw as Season) : null;
}

/**
 * GET /api/mobile/village — the native Village tab: this family's discovered
 * candidates + latest routine, teen-safe (a 13+ child's candidate/routine item is
 * redacted at the mapper inside loadVillage). This route never touches the DB
 * (rule #1). Auth() is the 401 gate.
 *
 * `?season=` (spring|summer|fall|winter) reads the latest SEARCH run for that
 * season instead of the standing feed; absent or invalid → the standing feed
 * (unchanged). The season-search results skip the calendar-season gate inside the
 * loader so a fall search viewed in summer still shows.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const season = seasonParam(req);
  // A season SEARCH read omits the Resources rail — the directory is not
  // season-scoped, so it belongs only on the standing feed.
  if (season) {
    const searchBody: MobileVillageResponse = await loadVillage({ searchSeason: season });
    return NextResponse.json(searchBody);
  }
  const [village, resources] = await Promise.all([loadVillage(), loadCuratedResources()]);
  const body: MobileVillageResponse = { ...village, resources };
  return NextResponse.json(body);
}
