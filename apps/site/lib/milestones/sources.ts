/**
 * The shared citations every milestone page carries, beside its own per-age CDC
 * checkpoint URL. The CDC checklists supply the milestone wording; the CPS page
 * supplies the Canadian "variation is normal / corrected age" framing; the CDC
 * "concerned" page grounds the when-to-chat-with-your-provider section. Kept in
 * one place so every page's citation list is consistent and auditable.
 *
 * All URLs fetched and confirmed live 2026-07-03 (CDC 2022 AAP/CDC revision).
 */
export const MILESTONE_SOURCES = {
  cdcIndex: {
    label: 'CDC — "Learn the Signs. Act Early." milestone checklists',
    url: 'https://www.cdc.gov/act-early/milestones/index.html',
  },
  cdcConcerned: {
    label: "CDC — Concerned About Your Child's Development?",
    url: 'https://www.cdc.gov/act-early/families/concerned.html',
  },
  cps: {
    label: "Canadian Paediatric Society — Your child's development: What to expect",
    url: 'https://caringforkids.cps.ca/handouts/behavior-and-development/your_childs_development',
  },
} as const;
