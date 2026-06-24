import { unstable_cache } from 'next/cache';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
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

/** How long a family's ranked order is reused before the agent re-ranks. */
const RANK_TTL_SECONDS = 60 * 30;

export interface VillageFeed {
  /** Candidates in the agent-decided order — the trusted feed. */
  candidates: VillageCandidateView[];
  /** True when the order is the agent's ranking (vs the raw discovery order). */
  ranked: boolean;
  /** Coarse area (FSA / city) for the feed header copy, or null. Never precise (rule #1). */
  areaCoarse: string | null;
}

const EMPTY_FEED: VillageFeed = { candidates: [], ranked: false, areaCoarse: null };

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

  if (candidates.length < 2) {
    return { candidates, ranked: false, areaCoarse };
  }

  const orderedIds = await rankedIdsCached(
    familyId,
    candidates.map((c) => c.id),
  );
  return { candidates: orderCandidates(candidates, orderedIds), ranked: true, areaCoarse };
}
