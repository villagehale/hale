'use server';

import { schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { rateLimitStatus } from '~/lib/rate-limit/apply';
import { flushTelemetry } from '~/lib/telemetry/langfuse';
import {
  type SearchContext,
  type SearchDeps,
  type VillageSearchOk,
  runVillageSearch,
} from './ai-search';
import { parseVillageSearchIntent } from './ai-search-parse';
import { resolveActiveAreaCoarse } from './areas';
import { findActivitiesAction } from './discover-action';
import { readVillage } from './queries';
import { searchActivitiesForSeason } from './search';
import type { Season } from './visibility';

/**
 * Server Action behind the Village natural-language search bar. Auth is the spend
 * gate (mirrors searchActivitiesForSeason / the coach route): preview (auth
 * unconfigured) / signed-out / no family all refuse BEFORE any model call. The cheap
 * intent parse is bounded by the village-ai-search limiter; the expensive discovery
 * it may trigger on thin results is separately bounded by village-search inside that
 * trigger. This is a read-only SEARCH, so it writes NO audit row of its own — the
 * discovery trigger it fires does its own audit (rule #6). A limiter denial returns a
 * structured rate_limited, never a swallowed error (rule #8).
 */

/** Bound the LLM input: a search is a short phrase. A longer paste is truncated
 * before it reaches the model (cost + prompt-injection surface). */
const MAX_PROMPT_LEN = 500;

export type VillageSearchResult =
  | VillageSearchOk
  | { status: 'unauthenticated' }
  | { status: 'no_family' }
  | { status: 'rate_limited'; retryAfter: number };

/**
 * Real production deps for runVillageSearch: the LLM intent parse, the family-scoped
 * candidate pool read (the #179 season/standing machinery — already teen-redacted),
 * the stored agent-rank order, and the fire-and-forget discovery trigger. `after`
 * runs the (billable, separately rate-limited) discovery AFTER the response is sent,
 * so a thin search returns instantly with "Hale is out looking" while the new
 * candidates land for the next read (mirrors feed.ts's background warm).
 */
function productionDeps(): SearchDeps {
  return {
    parseIntent: (ctx: SearchContext) =>
      parseVillageSearchIntent(
        {
          prompt: ctx.prompt,
          familyId: ctx.familyId,
          childrenAgesMonths: ctx.childrenAgesMonths,
          hasTeen: ctx.hasTeen,
          areaCoarse: ctx.areaCoarse,
        },
        ctx.database,
      ),
    readPool: async (database, familyId, season) => {
      const { candidates } = await readVillage(
        database,
        familyId,
        season ? { searchSeason: season } : undefined,
      );
      return candidates;
    },
    readStoredRank: async (database, familyId) => {
      const rows = await database
        .select({ orderedIds: schema.villageFeedRank.orderedIds })
        .from(schema.villageFeedRank)
        .where(eq(schema.villageFeedRank.familyId, familyId))
        .limit(1);
      return rows[0]?.orderedIds ?? null;
    },
    kickDiscovery: (_ctx, season: Season | null) => {
      // Fire-and-forget: the discovery run (billable, rate-limited by village-search
      // inside these triggers) executes after the response is sent, so the search
      // stays snappy and the parent is told to check back.
      after(async () => {
        if (season) {
          await searchActivitiesForSeason(season);
        } else {
          await findActivitiesAction();
        }
      });
    },
  };
}

export async function searchVillageAction(prompt: string): Promise<VillageSearchResult> {
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

  // Per-family cooldown on the cheap intent parse (the paid discovery it may trigger
  // is bounded separately). A denial is structured, never a swallowed error (rule #8).
  const limit = await rateLimitStatus('village-ai-search', familyId);
  if (!limit.allowed) {
    return { status: 'rate_limited', retryAfter: limit.retryAfterSec };
  }

  // Derive the search context: NON-TEEN children ages for age resolution, and a bare
  // hasTeen flag — a teen's age is NEVER read into the context (rule #1). Only the
  // COARSE area is used.
  const [childRows, areaCoarse] = await Promise.all([
    database
      .select({ dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    resolveActiveAreaCoarse(database, familyId),
  ]);

  const childrenAgesMonths: number[] = [];
  let hasTeen = false;
  for (const child of childRows) {
    if (deriveStage(child.dateOfBirth) === 'teenager') {
      hasTeen = true;
    } else {
      childrenAgesMonths.push(ageInMonths(child.dateOfBirth));
    }
  }

  const ctx: SearchContext = {
    prompt: prompt.trim().slice(0, MAX_PROMPT_LEN),
    database,
    familyId,
    childrenAgesMonths,
    hasTeen,
    areaCoarse,
  };

  try {
    return await runVillageSearch(ctx, productionDeps());
  } finally {
    // Serverless flush: send the intent-parse trace's buffered spans before we return
    // (rule #8). The fire-and-forget discovery flushes its own trace in its action.
    await flushTelemetry();
  }
}
