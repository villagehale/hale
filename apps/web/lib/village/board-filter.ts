import type { CuratedResourceView } from './curated-resources';
import type { VillageCandidateView } from './mappers';

/**
 * The five content-type filters the Village board offers, matching the desktop
 * handoff's chip row (§4.5). Each maps to REAL loaded data (candidates vs curated
 * resources), never a fabricated category:
 *   - `all`         — activities + resources.
 *   - `activities`  — the village candidate feed only.
 *   - `childcare`   — curated resources in the real childcare category (EarlyON
 *                     child & family centres) only.
 *   - `resources`   — the trusted/curated resources only.
 *   - `playgrounds` — the outdoor half of BOTH datasets: candidates the discovery
 *                     run classified as outdoor play + curated "Parks & splash pads"
 *                     resources. It is the honest real equivalent of the mockup's
 *                     "Playgrounds" chip (a park playground + a splash pad), never a
 *                     fabricated tab.
 */
export type BoardFilter = 'all' | 'activities' | 'resources' | 'childcare' | 'playgrounds';

/** The one curated-resource category the "Childcare" pill narrows to. It is a
 * REAL value present in the curated seed (curated-resources-data.ts), so the pill
 * always has backing rows — a "Childcare" filter over no real category would be a
 * fabricated tab (honesty-first). */
export const CHILDCARE_RESOURCE_CATEGORY = 'EarlyON child & family centres';

/** The curated-resource category the "Playgrounds" pill narrows to — a REAL value
 * present in the curated seed (parks and splash pads), so the pill always has
 * backing rows on the resources side. */
export const PLAYGROUND_RESOURCE_CATEGORY = 'Parks & splash pads';

/** Whether a candidate reads as outdoor play for the "Playgrounds" pill: the
 * discovery run either classified its KIND as outdoor, or tagged it outdoor on the
 * indoor/outdoor attribute. Both are REAL discovery signals — the pill never invents
 * a "playground" classification the model didn't produce. */
export function isPlaygroundCandidate(candidate: VillageCandidateView): boolean {
  return candidate.kind === 'outdoor' || candidate.indoorOutdoor === 'outdoor';
}

/** Case-insensitive substring match of `query` against the given fields. An empty
 * query matches everything (no narrowing on first paint). */
function matches(query: string, ...fields: Array<string | null>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/**
 * The activity rows for a given filter + search query. `resources` and `childcare`
 * show no activities (those chips are resource-only); `playgrounds` narrows to the
 * outdoor candidates FIRST; `all`/`activities` keep every candidate; then all search
 * over the candidate's own real fields (title, kind, summary).
 */
export function filterActivities(
  candidates: VillageCandidateView[],
  filter: BoardFilter,
  query: string,
): VillageCandidateView[] {
  if (filter === 'resources' || filter === 'childcare') return [];
  const scoped =
    filter === 'playgrounds' ? candidates.filter(isPlaygroundCandidate) : candidates;
  return scoped.filter((c) => matches(query, c.title, c.kind, c.summary));
}

/**
 * The resource rows for a given filter + search query. `activities` shows none;
 * `childcare` narrows to the real childcare category and `playgrounds` to the real
 * parks category FIRST; `all`/`resources` keep every resource; then all search over
 * the resource's own real fields (name, category, description).
 */
export function filterResources(
  resources: CuratedResourceView[],
  filter: BoardFilter,
  query: string,
): CuratedResourceView[] {
  if (filter === 'activities') return [];
  const category =
    filter === 'childcare'
      ? CHILDCARE_RESOURCE_CATEGORY
      : filter === 'playgrounds'
        ? PLAYGROUND_RESOURCE_CATEGORY
        : null;
  const scoped = category ? resources.filter((r) => r.category === category) : resources;
  return scoped.filter((r) => matches(query, r.name, r.category, r.description));
}
