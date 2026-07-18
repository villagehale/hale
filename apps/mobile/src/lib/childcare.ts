import type { CuratedResourceView } from './api-types';

/**
 * The one curated-resource category that IS childcare on the real backend. Childcare
 * is NOT a village-candidate kind (the web board hides all candidates under its
 * "childcare" filter); it is a curated-resource category. MIRRORS the web constant
 * `CHILDCARE_RESOURCE_CATEGORY` in apps/web/lib/village/board-filter.ts — a DATA
 * value that must match the served category string exactly, so keep the two in sync.
 */
export const CHILDCARE_RESOURCE_CATEGORY = 'EarlyON child & family centres';

/** The real childcare rows for the Childcare Options page: curated resources in the
 * childcare category, drawn from the SAME `resources` the Village read already
 * delivers (family-agnostic public programs — no PII, no teen attribution). */
export function childcareResources(
  resources: CuratedResourceView[] | undefined,
): CuratedResourceView[] {
  if (!resources) return [];
  return resources.filter((r) => r.category === CHILDCARE_RESOURCE_CATEGORY);
}
