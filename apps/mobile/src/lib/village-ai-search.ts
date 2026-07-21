import type { VillageCandidateView } from './api-types';

/**
 * The Village natural-language search decision layer — the framework-free counterpart
 * to POST /api/mobile/village/ai-search (which wraps the web searchVillageAction). It
 * maps the server's honest outcome to the screen's view state and owns the error copy,
 * so the RN screen stays review-only. No I/O, no RN import — unit-tested off-device.
 *
 * Privacy (rule #1): results are the already teen-redacted candidate views; the
 * interpretation is Hale's own paraphrase, never raw child content.
 */

/** The mobile ai-search response (mirrors MobileVillageAiSearchResponse). */
export interface AiSearchResponse {
  /** Hale's paraphrase of the request — the "Hale understood: …" echo. */
  interpretation: string;
  results: VillageCandidateView[];
  /** The intent parse fell back to a coarse interpretation (surfaced quietly). */
  degraded: boolean;
  /** Thin results kicked a background discovery run — new picks are on the way. */
  discoveryKicked: boolean;
}

export type AiSearchView =
  | { kind: 'results'; interpretation: string; results: VillageCandidateView[] }
  | { kind: 'out-looking'; interpretation: string }
  | { kind: 'empty'; interpretation: string };

/**
 * Real results win; otherwise a thin set that kicked discovery is "out looking" (new
 * picks landing for the next read), and a genuinely empty intent with nothing is the
 * calm empty state. The interpretation echo rides every branch.
 */
export function aiSearchViewFrom(response: AiSearchResponse): AiSearchView {
  if (response.results.length > 0) {
    return { kind: 'results', interpretation: response.interpretation, results: response.results };
  }
  if (response.discoveryKicked) {
    return { kind: 'out-looking', interpretation: response.interpretation };
  }
  return { kind: 'empty', interpretation: response.interpretation };
}

/** Honest copy for a failed ai-search request, by status. A 401 never lands here (the
 * api client redirects to sign-in). */
export function aiSearchErrorMessage(status: number): string {
  if (status === 429) return "You've searched a lot — give it a moment, then try again.";
  if (status === 403) return 'Finish setting up your family to search your village.';
  return "Couldn't run that search just now — try again.";
}
