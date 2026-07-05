import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { defaultDiscoverDeps, discoverForFamily } from '~/lib/village/discover';
import { flushTelemetry } from '~/lib/telemetry/langfuse';
import { SEASONS } from '~/lib/village/visibility';

// Node runtime: discovery uses the Anthropic SDK + the Drizzle client.
export const runtime = 'nodejs';

const bodySchema = z.object({ season: z.enum(SEASONS) });

/**
 * POST /api/mobile/village/search — the native, HTTP-callable counterpart to the
 * web searchActivitiesForSeasonAction Server Action (Server Actions aren't
 * mobile-callable). A parent triggers a FRESH, season-scoped discovery run that
 * coexists with the standing feed. Mirrors the mobile route auth pattern: dev
 * preview (no DB) → 503, signed-out → 401, invalid season → 400, no resolved family
 * → 403. Rate-limited per family (village-search cooldown) — a 429 short-circuits
 * before the billable discovery (rule #8: structured, with Retry-After).
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_season' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const limited = await enforceRateLimit('village-search', familyId);
  if (limited) return limited;

  try {
    const result = await discoverForFamily(familyId, database, defaultDiscoverDeps(), {
      searchSeason: parsed.data.season,
    });
    return NextResponse.json(result);
  } finally {
    await flushTelemetry();
  }
}
