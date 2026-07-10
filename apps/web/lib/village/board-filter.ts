import type { CuratedResourceView } from './curated-resources';
import type { VillageCandidateView } from './mappers';

/**
 * The four content-type filters the Village board offers, matching the mockup's
 * pill row. Each maps to REAL loaded data (candidates vs curated resources), never
 * a fabricated category:
 *   - `all`        — both columns.
 *   - `activities` — the village candidate feed only.
 *   - `resources`  — the trusted/curated resources only.
 *   - `childcare`  — curated resources in the real childcare category (EarlyON
 *                    child & family centres), shown in the Resources column only.
 */
export type BoardFilter = 'all' | 'activities' | 'resources' | 'childcare';

/** The one curated-resource category the "Childcare" pill narrows to. It is a
 * REAL value present in the curated seed (curated-resources-data.ts), so the pill
 * always has backing rows — a "Childcare" filter over no real category would be a
 * fabricated tab (honesty-first). */
export const CHILDCARE_RESOURCE_CATEGORY = 'EarlyON child & family centres';

/** Case-insensitive substring match of `query` against the given fields. An empty
 * query matches everything (no narrowing on first paint). */
function matches(query: string, ...fields: Array<string | null>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/**
 * The activities column contents for a given filter + search query. `resources`
 * and `childcare` show no activities (the column is hidden); `all`/`activities`
 * search over the candidate's own real fields (title, kind, summary).
 */
export function filterActivities(
  candidates: VillageCandidateView[],
  filter: BoardFilter,
  query: string,
): VillageCandidateView[] {
  if (filter === 'resources' || filter === 'childcare') return [];
  return candidates.filter((c) => matches(query, c.title, c.kind, c.summary));
}

/**
 * The resources column contents for a given filter + search query. `activities`
 * shows none; `childcare` narrows to the real childcare category FIRST, then
 * searches; `all`/`resources` search over the resource's own real fields (name,
 * category, description).
 */
export function filterResources(
  resources: CuratedResourceView[],
  filter: BoardFilter,
  query: string,
): CuratedResourceView[] {
  if (filter === 'activities') return [];
  const scoped =
    filter === 'childcare'
      ? resources.filter((r) => r.category === CHILDCARE_RESOURCE_CATEGORY)
      : resources;
  return scoped.filter((r) => matches(query, r.name, r.category, r.description));
}
