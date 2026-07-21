import type { VillageCandidateView } from './mappers';

/** Reorder candidate views to match the agent's ordered ids; any view whose id the
 * order omits is appended in its original position (defence in depth — the ranker
 * already reconciles, but the feed never drops a card). Pure, so both the home feed
 * (feed.ts) and the natural-language search (ai-search.ts) share one ordering
 * primitive without dragging in the feed's Next/DB import graph. */
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
