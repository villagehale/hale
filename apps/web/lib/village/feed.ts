import { unstable_cache } from 'next/cache';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { geocodeVenue } from './geocode';
import type { LatLng } from './map-model';
import type { VillageCandidateView } from './mappers';
import { readVillage } from './queries';
import { rankRecommendations } from './rank/rank';

/**
 * The agent-ranked village feed — the home/primary surface's data source. It is
 * the moat made the centerpiece: instead of the discovery-order list, the family
 * sees their candidates ORDERED by the rank-recommendations agent (fit + trust +
 * memory), so the feed reads as "what your village, and families like yours,
 * recommend near you."
 *
 * Bounded spend (rule #7): the agent ranking is wrapped in `unstable_cache`,
 * keyed by familyId AND a fingerprint of the candidate-id set. A re-render, a tab
 * switch, or a second visit reuses the cached order — the model is re-run only
 * when the candidate set actually changes (a new discovery) or the TTL lapses, so
 * the home page never re-spends per render. The endorsement/teen-redaction reads
 * still run fresh each render (cheap DB reads), so social proof and teen safety
 * are always current; only the ORDER is cached.
 *
 * Teen safety (rule #1): the feed reorders the SAME teen-redacted views readVillage
 * produces — a teen-attributed candidate is already category-only before it enters
 * the feed, and reordering never un-redacts it.
 */

/**
 * Safety-net TTL only. The cache key already includes the candidate-id
 * fingerprint, so a new discovery re-ranks automatically; an endorsement
 * invalidates the `village-feed:<family>` tag explicitly. This long TTL just
 * catches changes not otherwise invalidated (e.g. a child's stage crossing a
 * boundary) — so the model is no longer re-run on unchanged inputs every 30 min.
 */
const RANK_TTL_SECONDS = 60 * 60 * 24;

export interface VillageFeed {
  /** Candidates in the agent-decided order — the trusted feed. */
  candidates: VillageCandidateView[];
  /** True when the order is the agent's ranking (vs the raw discovery order). */
  ranked: boolean;
  /** Coarse area (FSA / city) for the feed header copy, or null. Never precise (rule #1). */
  areaCoarse: string | null;
  /** Centroid of the COARSE area (FSA / city) for the map's default center — the
   * map centers here, NEVER the precise home (rule #1). Null when there is no
   * area or it couldn't be geocoded; the map then fits its public-venue markers. */
  coarseCenter: LatLng | null;
}

const EMPTY_FEED: VillageFeed = {
  candidates: [],
  ranked: false,
  areaCoarse: null,
  coarseCenter: null,
};

/** How long a coarse-area centroid is reused before re-geocoding — the centroid
 * of an FSA/city is effectively static, so a long TTL keeps Places calls rare. */
const CENTER_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Geocode the COARSE area string (e.g. "M4K", "Toronto") to a centroid for the
 * map's default center, cached by the area string so the same area never
 * re-geocodes within the TTL. Best-effort: a miss yields null (the map fits its
 * markers instead). Only the coarse area is ever sent — never a precise home
 * (rule #1).
 */
function coarseCenterCached(areaCoarse: string): Promise<LatLng | null> {
  const run = unstable_cache(
    async () => {
      const resolved = await geocodeVenue(areaCoarse, '');
      return resolved ? { lat: resolved.lat, lng: resolved.lng } : null;
    },
    ['village-coarse-center', areaCoarse],
    { revalidate: CENTER_TTL_SECONDS, tags: ['village-coarse-center'] },
  );
  return run();
}

/** Reorder candidate views to match the agent's ordered ids; any view whose id
 * the order omits is appended in its original position (defence in depth — the
 * ranker already reconciles, but the feed never drops a card). */
export function orderCandidates(
  candidates: VillageCandidateView[],
  orderedIds: string[],
): VillageCandidateView[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ordered: VillageCandidateView[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const candidate = byId.get(id);
    if (candidate && !seen.has(id)) {
      seen.add(id);
      ordered.push(candidate);
    }
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

/**
 * Run (or reuse) the agent ranking for one family's candidate set. Cached by
 * familyId + candidate-id fingerprint so the model is invoked only when the set
 * changes or the TTL lapses (bounded spend, rule #7). Constructs its own deps so
 * only serializable args cross the cache boundary.
 */
function rankedIdsCached(familyId: string, candidateIds: string[]): Promise<string[]> {
  const fingerprint = candidateIds.join(',');
  const run = unstable_cache(
    async () => {
      const { orderedIds } = await rankRecommendations(
        { familyId, candidateIds, actor: 'system' },
        defaultDb(),
      );
      return orderedIds;
    },
    ['village-feed-rank', familyId, fingerprint],
    { revalidate: RANK_TTL_SECONDS, tags: [`village-feed:${familyId}`] },
  );
  return run();
}

/**
 * Loads the agent-ranked feed for the signed-in family. Mirrors loadVillage's
 * preview/unauthed boundary: no DATABASE_URL (preview) or no resolved family →
 * the empty feed, no model call, no spend. Fewer than two candidates → nothing to
 * rank, so the discovery order is returned as-is (no spend). Otherwise the agent
 * ranks and the views are reordered.
 */
export async function loadVillageFeed(): Promise<VillageFeed> {
  if (!process.env.DATABASE_URL) return EMPTY_FEED;
  const database: Database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return EMPTY_FEED;

  const [{ candidates }, areaRows] = await Promise.all([
    readVillage(database, familyId),
    database
      .select({ areaCoarse: schema.families.areaCoarse })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1),
  ]);
  const areaCoarse = areaRows[0]?.areaCoarse ?? null;
  const coarseCenter = areaCoarse ? await coarseCenterCached(areaCoarse) : null;

  if (candidates.length < 2) {
    return { candidates, ranked: false, areaCoarse, coarseCenter };
  }

  try {
    const orderedIds = await rankedIdsCached(
      familyId,
      candidates.map((c) => c.id),
    );
    return {
      candidates: orderCandidates(candidates, orderedIds),
      ranked: true,
      areaCoarse,
      coarseCenter,
    };
  } catch {
    // The ranker is an enhancement, not a gate: if the model is unavailable
    // (rate-limited or spend-capped), serve the discovery order so the feed still
    // renders. ranked:false signals the un-ranked fallback; the failure is captured
    // in the agent's Langfuse trace, so it is observable, not silently swallowed.
    return { candidates, ranked: false, areaCoarse, coarseCenter };
  }
}
