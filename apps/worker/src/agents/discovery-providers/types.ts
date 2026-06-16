import type { DiscoveredActivity, DiscoveryQuery } from '@hale/types';

/**
 * Where a candidate came from, in increasing order of grounding:
 *  - `curated_seed`  — the Fake floor's hand-curated, geo-agnostic seed list.
 *  - `llm_only`      — the web-grounded provider ran but produced no live
 *                      grounding URL; the item rests on the model's general
 *                      knowledge, so it carries lower confidence.
 *  - `web_grounded`  — backed by a live web-search result; `sourceUrl` is that
 *                      result's public listing.
 */
export type DiscoverySource = 'curated_seed' | 'llm_only' | 'web_grounded';

/**
 * A provider's output. Extends the @hale/types `DiscoveredActivity` contract
 * (title, description, stage, areaCoarse, sourceUrl?) with the honesty fields
 * the village UI and `village_candidates` row need: `source` (provenance),
 * `confidence` (calibrated 0–1), and a coarse `coverageNote`. These three are
 * not on the bare contract because both Fake and web-grounded providers must
 * be honest about provenance, and the floor must never present curated guesses
 * with the same confidence as a grounded result.
 */
export interface DiscoveredCandidate extends DiscoveredActivity {
  source: DiscoverySource;
  /** Honest probability the activity exists in this area and fits the stage. */
  confidence: number;
  /** Coarse, human-readable coverage note (e.g. "common in most areas"); never precise. */
  coverageNote: string;
}

/**
 * Pluggable source of local activities, injected into `runDiscovery` like the
 * executor's deps. The Fake floor is always available; the web-grounded
 * provider sits behind a config flag. Returns the richer `DiscoveredCandidate`
 * so provenance and calibrated confidence survive to persistence.
 */
export interface DiscoveryProvider {
  /** Stable identifier (e.g. "fake", "web_grounded") — recorded on each row. */
  readonly name: string;
  discover(query: DiscoveryQuery): Promise<DiscoveredCandidate[]>;
}
