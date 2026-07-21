import type { VillageCandidateView } from './mappers';
import type { VillageSearchResult } from './ai-search-action';

/**
 * The pure presentational decision for a search result — which surface the
 * VillageAiSearch component shows. Kept out of the component (and free of any
 * server/JSX import) so the state→surface mapping is unit-tested against the spec,
 * not asserted through a renderer the repo has no harness for. The component is then
 * a thin switch over this descriptor.
 */
export type SearchView =
  | {
      kind: 'results';
      interpretation: string;
      results: VillageCandidateView[];
      degraded: boolean;
      /** Thin set → discovery was kicked; the UI adds a "still looking" note. */
      stillLooking: boolean;
    }
  | { kind: 'empty'; interpretation: string; degraded: boolean; stillLooking: boolean }
  | { kind: 'notice'; interpretation: string; title: string; body: string };

export function resolveSearchView(result: VillageSearchResult): SearchView {
  if (result.status === 'rate_limited') {
    return {
      kind: 'notice',
      interpretation: 'one moment',
      title: 'you’ve searched a lot just now.',
      body: 'Give it a minute and try your search again.',
    };
  }
  if (result.status === 'unauthenticated' || result.status === 'no_family') {
    return {
      kind: 'notice',
      interpretation: 'not signed in',
      title: 'sign in to search your village.',
      body: 'Your village is personal to your family.',
    };
  }

  const { interpretation, results, degraded, discoveryKicked } = result;
  if (results.length > 0) {
    return { kind: 'results', interpretation, results, degraded, stillLooking: discoveryKicked };
  }
  return { kind: 'empty', interpretation, degraded, stillLooking: discoveryKicked };
}
