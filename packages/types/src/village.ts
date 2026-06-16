import type { FamilyStage } from './stage.js';

/**
 * Village discovery — the contract for finding local, stage-appropriate
 * enrichment activities. The provider is INJECTED into the discovery agent
 * (a Fake floor always available; a real web-grounded impl behind a flag),
 * so the shape lives here in @hale/types where both apps and the worker can
 * depend on it without importing worker internals.
 *
 * Hard rule #1 (privacy) is encoded in the QUERY shape, not just enforced by
 * convention: a query carries a COARSE area (an FSA / neighborhood string) and
 * the child's STAGE — never a precise child location, name, or date of birth.
 * A provider cannot receive precise location because the type has no field for
 * it.
 */
export interface DiscoveryQuery {
  /**
   * Coarse area only — a forward-sortation-area or neighborhood label
   * (e.g. "M5V", "Plateau"). Never a street address or precise coordinates
   * (hard rule #1: never precise child location).
   */
  areaCoarse: string;
  /** The child's derived stage — drives stage-appropriateness of results. */
  stage: FamilyStage;
  /** Free-form interest tags (e.g. "music", "swimming") to bias discovery. */
  interests: string[];
  /** Upper bound on results the caller wants back. */
  limit: number;
}

/**
 * One discovered enrichment activity. Provider-agnostic: the Fake and the
 * web-grounded provider both return this shape. `sourceUrl` is the activity's
 * public listing (a venue/program page), never anything family-identifying.
 */
export interface DiscoveredActivity {
  title: string;
  description: string;
  /** The stage this activity suits — lets the routine agent match by stage. */
  stage: FamilyStage;
  /** Coarse area the activity is in — echoes the query's granularity. */
  areaCoarse: string;
  /** Public listing URL for the activity, when one is known. */
  sourceUrl?: string;
}

/**
 * Pluggable source of local activities. Implemented by the always-available
 * Fake (deterministic floor) and the web-grounded provider (behind a flag).
 * Injected like the executor's deps, so discovery is testable without a live
 * network call.
 */
export interface DiscoveryProvider {
  /** Stable identifier for the provider (e.g. "fake", "web-grounded") — audited. */
  readonly name: string;
  discover(query: DiscoveryQuery): Promise<DiscoveredActivity[]>;
}
