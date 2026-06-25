import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { unstable_cache } from 'next/cache';
import { after } from 'next/server';
import { kickDrain } from '~/lib/cron/kick-drain';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { getQueue } from '~/lib/queue';
import { geocodeVenue } from './geocode';
import type { LatLng } from './map-model';
import type { VillageCandidateView } from './mappers';
import { readVillage } from './queries';

/**
 * The agent-ranked village feed — the home/primary surface's data source. It is
 * the moat made the centerpiece: instead of the discovery-order list, the family
 * sees their candidates ORDERED by the rank-recommendations agent (fit + trust +
 * memory), so the feed reads as "what your village, and families like yours,
 * recommend near you."
 *
 * Fan-out-on-WRITE: the ~25s ranker NEVER runs in this request path. It is
 * materialized in the BACKGROUND (upsertFeedRank, on the discovery/endorse write
 * events) into village_feed_rank, so this read is a pure DB lookup of the stored
 * order. A cold family with no row yet is served the discovery order immediately
 * (stale-while-revalidate) and a background rerank is enqueued to warm it for the
 * next visit — so the home page renders instantly either way (bounded spend,
 * rule #7: the background upsert short-circuits an unchanged candidate set).
 *
 * Teen safety (rule #1): the feed reorders the SAME teen-redacted views readVillage
 * produces — a teen-attributed candidate is already category-only before it enters
 * the feed, and reordering never un-redacts it.
 */

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
 * Warm a cold family's feed rank in the BACKGROUND: enqueue a village.rerank job
 * and kick the drain so the materialization runs out of this request path. Best
 * effort — a failure to warm is swallowed (the feed already rendered in discovery
 * order; the next discovery/endorse write, or the next visit, will warm it).
 */
async function enqueueRerankWarm(familyId: string): Promise<void> {
  try {
    const queue = await getQueue();
    await queue.send('village.rerank', { family_id: familyId });
    if (process.env.APP_URL) {
      after(() => kickDrain(process.env.APP_URL as string));
    }
  } catch (err) {
    console.error(
      { err, familyId },
      'feed: failed to enqueue rerank warm (will warm on next write)',
    );
  }
}

/**
 * Loads the agent-ranked feed for the signed-in family — a PURE DB read; the
 * ~25s ranker NEVER runs here (fan-out-on-write). Mirrors loadVillage's
 * preview/unauthed boundary: no DATABASE_URL (preview) or no resolved family →
 * the empty feed. Fewer than two candidates → nothing to rank, discovery order.
 * A materialized village_feed_rank row → the stored agent order (ranked:true). No
 * row yet → the discovery order now (ranked:false) plus a background rerank to
 * warm it for next time.
 */
export async function loadVillageFeed(): Promise<VillageFeed> {
  if (!process.env.DATABASE_URL) return EMPTY_FEED;
  const database: Database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return EMPTY_FEED;

  const [{ candidates }, areaRows, rankRows] = await Promise.all([
    readVillage(database, familyId),
    database
      .select({ areaCoarse: schema.families.areaCoarse })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1),
    database
      .select({ orderedIds: schema.villageFeedRank.orderedIds })
      .from(schema.villageFeedRank)
      .where(eq(schema.villageFeedRank.familyId, familyId))
      .limit(1),
  ]);
  const areaCoarse = areaRows[0]?.areaCoarse ?? null;
  const coarseCenter = areaCoarse ? await coarseCenterCached(areaCoarse) : null;

  if (candidates.length < 2) {
    return { candidates, ranked: false, areaCoarse, coarseCenter };
  }

  const orderedIds = rankRows[0]?.orderedIds ?? null;
  if (orderedIds) {
    return {
      candidates: orderCandidates(candidates, orderedIds),
      ranked: true,
      areaCoarse,
      coarseCenter,
    };
  }

  // No materialized order yet — serve the discovery order now and warm the rank
  // in the background so the next visit is ranked. The model never runs here.
  await enqueueRerankWarm(familyId);
  return { candidates, ranked: false, areaCoarse, coarseCenter };
}
