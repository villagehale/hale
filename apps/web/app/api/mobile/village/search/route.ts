import { NextResponse } from 'next/server';
import { searchActivitiesForSeason } from '~/lib/village/search';
import type { Season } from '~/lib/village/visibility';

// Node runtime: the shared search core uses the Anthropic SDK + the Drizzle client.
export const runtime = 'nodejs';

/**
 * POST /api/mobile/village/search — the native, HTTP-callable counterpart to the
 * web searchActivitiesForSeasonAction Server Action (Server Actions aren't
 * mobile-callable). A parent triggers a FRESH, season-scoped discovery run that
 * coexists with the standing feed. All auth, family-resolution, rate-limiting, and
 * DB access live in the shared searchActivitiesForSeason core — this route only
 * maps its structured result to HTTP so it never touches the database directly
 * (rule #1). no DB (dev preview) → 503, signed-out → 401, invalid season → 400,
 * no family → 403, over the cap → 429 with Retry-After (rule #8, structured).
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  // The core validates the season (returns invalid_season for anything unknown),
  // so an untrusted string is safe to hand it — the cast just satisfies the param.
  const body = (await req.json().catch(() => null)) as { season?: string } | null;
  const result = await searchActivitiesForSeason((body?.season ?? '') as Season);

  switch (result.status) {
    case 'invalid_season':
      return NextResponse.json({ error: 'invalid_season' }, { status: 400 });
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    case 'no_family':
      return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      );
    default:
      return NextResponse.json(result);
  }
}
