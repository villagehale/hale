'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { rateLimitStatus } from '~/lib/rate-limit/apply';
import { flushTelemetry } from '~/lib/telemetry/langfuse';
import { type DiscoverResult, defaultDiscoverDeps, discoverForFamily } from './discover';
import { SEASONS, type Season } from './visibility';

/**
 * Server Action behind the "Find <season> activities" control on /village.
 *
 * Unlike the standing findActivitiesAction, this is a PAID, on-demand search a
 * parent triggers per season, so it is rate-limited (village-search: a per-family
 * hourly cooldown). Auth is the spend gate (mirrors findActivitiesAction): dev
 * preview / signed-out / no family all refuse BEFORE any model call. A limiter
 * denial returns a structured { status: 'rate_limited', retryAfter } — never a bare
 * throw or a swallowed null (rule #8). On success the page is revalidated so the
 * search run's candidates render.
 */

export type SearchActivitiesResult =
  | DiscoverResult
  | { status: 'invalid_season' }
  | { status: 'unauthenticated' }
  | { status: 'no_family' }
  | { status: 'rate_limited'; retryAfter: number };

function isSeason(value: string): value is Season {
  return (SEASONS as readonly string[]).includes(value);
}

export async function searchActivitiesForSeasonAction(
  season: Season,
): Promise<SearchActivitiesResult> {
  // Validate before auth/limiter/spend: a client can't ask discovery to scope to
  // an arbitrary season string.
  if (!isSeason(season)) {
    return { status: 'invalid_season' };
  }

  if (!authConfigured()) {
    return { status: 'unauthenticated' };
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return { status: 'unauthenticated' };
  }

  const database = defaultDb();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'no_family' };
  }

  // Per-family cooldown before the billable discovery — the run's cost belongs to
  // the family (rule #7 spirit: bound spend on an explicitly-triggered paid run).
  const limit = await rateLimitStatus('village-search', familyId);
  if (!limit.allowed) {
    return { status: 'rate_limited', retryAfter: limit.retryAfterSec };
  }

  try {
    const result = await discoverForFamily(familyId, database, defaultDiscoverDeps(), {
      searchSeason: season,
    });
    revalidatePath('/village');
    return result;
  } finally {
    // Serverless flush: send the discovery trace's buffered spans before the
    // Server Action returns (rule #8).
    await flushTelemetry();
  }
}
