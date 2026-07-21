import type { Database } from '@hale/db';
import {
  type VillageSearchIntent,
  formatInterpretation,
  isEmptyIntent,
} from './ai-search-intent';
import type { ParsedIntent } from './ai-search-parse';
import { isPlaygroundCandidate } from './board-filter';
import type { VillageCandidateView } from './mappers';
import { orderCandidates } from './order-candidates';
import type { Season } from './visibility';

/**
 * The Village natural-language search core. It orchestrates the honesty
 * architecture: the LLM parses the ask into an intent (NEVER a listing), then the
 * results come EXCLUSIVELY from real data —
 *
 *  - the candidate pool is the family's own discovered candidates, read through the
 *    #179 season/standing machinery: an intent with a season reads that season's
 *    SEARCH run (season-gate skipped, so a fall search shows in summer); an intent
 *    with no season reads the STANDING feed in its agent-ranked order (stored rank,
 *    never a live re-rank in the request path);
 *  - the intent then FILTERS that real pool (category/keyword over each candidate's
 *    own fields) — it can only ever narrow real rows, never add one;
 *  - a thin result set (below MIN_RESULTS) KICKS the existing discovery trigger for
 *    the intent's season/area and says so honestly ("Hale is out looking"), rather
 *    than fabricating a program to fill the gap.
 *
 * Everything DB/LLM-touching is injected (SearchDeps) so the orchestration — pool
 * selection, area scoping, the thin-results trigger, the interpretation echo — is
 * unit-tested without a live model or DB. Teen safety (rule #1) rides in from the
 * pool (readVillage already teen-redacts) and is reinforced here: a teen-attributed
 * card carries no searchable content and never surfaces as a focused search result.
 */

/** Below this many real matches, the search kicks discovery to go find more. */
export const MIN_RESULTS = 3;

export interface VillageSearchOk {
  status: 'ok';
  /** The honest "what Hale understood" echo the UI shows above the results. */
  interpretation: string;
  /** Real, teen-safe candidate views — never fabricated. */
  results: VillageCandidateView[];
  /** True when the LLM parse fell back to deterministic keywords (rule #8). */
  degraded: boolean;
  /** True when results were thin and discovery was kicked to find more. */
  discoveryKicked: boolean;
}

export interface SearchContext {
  prompt: string;
  database: Database;
  familyId: string;
  /** NON-TEEN children ages in months (rule #1: teen ages excluded). */
  childrenAgesMonths: number[];
  hasTeen: boolean;
  areaCoarse: string | null;
}

export interface SearchDeps {
  /** Parse the prompt into a typed intent (the LLM seam + deterministic fallback). */
  parseIntent: (ctx: SearchContext) => Promise<ParsedIntent>;
  /** Read the family's candidate pool: the standing feed, or a season's SEARCH run
   * when `season` is given. Already teen-redacted (readVillage). */
  readPool: (
    database: Database,
    familyId: string,
    season: Season | null,
  ) => Promise<VillageCandidateView[]>;
  /** The family's stored agent-rank order (village_feed_rank) for the STANDING pool,
   * or null when none is materialized yet — then the pool keeps its confidence order. */
  readStoredRank: (database: Database, familyId: string) => Promise<string[] | null>;
  /** Fire-and-forget the existing discovery trigger for a thin result set — a season
   * search-run discovery, or standing discovery when no season. Never awaited (the
   * search returns immediately and says "Hale is out looking"). */
  kickDiscovery: (ctx: SearchContext, season: Season | null) => void;
}

/** Case-insensitive substring match of `term` against any of the given real fields. */
function fieldMatch(term: string, fields: Array<string | null>): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return false;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/**
 * Narrow a real candidate pool to an intent — PURELY: it can only ever drop rows,
 * never add or invent one. A teen-attributed card is excluded (it carries no
 * searchable content — title/summary are redacted — and a locked card is noise in a
 * focused "find me X" result, rule #1). A `playgrounds`-only category narrows to the
 * outdoor candidates; keywords then keep rows whose OWN fields (title/kind/summary/
 * age hint) contain any term. No keywords → the category-scoped pool as-is (a
 * category/season browse). The pool's incoming order (agent rank or confidence) is
 * preserved.
 */
export function filterCandidatesByIntent(
  candidates: VillageCandidateView[],
  intent: VillageSearchIntent,
): VillageCandidateView[] {
  const searchable = candidates.filter((c) => !c.teenAttributed);

  const playgroundsOnly =
    intent.categories.includes('playgrounds') && !intent.categories.includes('activities');
  const scoped = playgroundsOnly ? searchable.filter(isPlaygroundCandidate) : searchable;

  if (intent.keywords.length === 0) return scoped;
  return scoped.filter((c) =>
    intent.keywords.some((term) => fieldMatch(term, [c.title, c.kind, c.summary, c.ageRange])),
  );
}

/**
 * Run a natural-language village search end to end over injected deps. Returns the
 * honest interpretation, the real filtered results, whether the parse degraded, and
 * whether discovery was kicked for a thin set. Never throws for a normal search — a
 * parse failure degrades (rule #8), an empty pool is a valid honest empty result.
 */
export async function runVillageSearch(
  ctx: SearchContext,
  deps: SearchDeps,
): Promise<VillageSearchOk> {
  // The stored rank depends only on familyId, not the parse, so start it BEFORE the
  // multi-second LLM parse and let the DB round-trip overlap it — the standing branch
  // then awaits an already-in-flight read instead of appending a fresh one.
  const rankPromise = deps.readStoredRank(ctx.database, ctx.familyId);

  const { intent, degraded } = await deps.parseIntent(ctx);

  const pool = await deps.readPool(ctx.database, ctx.familyId, intent.season);

  // Apply the family's stored agent-rank order to the STANDING pool so search results
  // read in the same trusted order as the feed (rule: rank via the stored ranks, never
  // a live re-rank in this path). A season SEARCH run has no stored rank — it keeps its
  // confidence order.
  let ordered = pool;
  if (intent.season === null) {
    const rankIds = await rankPromise;
    if (rankIds) ordered = orderCandidates(pool, rankIds);
  } else {
    // A season search never uses the standing rank; discard the started read without
    // letting it reject unhandled (it's a best-effort ordering input, not a user action).
    void rankPromise.catch(() => undefined);
  }

  const results = filterCandidatesByIntent(ordered, intent);

  // Thin real results → go look for more via the existing discovery trigger, and say
  // so. An EMPTY intent (pure chatter) still searches the standing pool but should not
  // trigger a paid discovery on nonsense — only a real ask that came up thin does.
  const discoveryKicked = results.length < MIN_RESULTS && !isEmptyIntent(intent);
  if (discoveryKicked) {
    deps.kickDiscovery(ctx, intent.season);
  }

  return {
    status: 'ok',
    interpretation: formatInterpretation(intent),
    results,
    degraded,
    discoveryKicked,
  };
}
