import type { CoachingFramework } from '@hale/types';

/**
 * Answer pages cite the permitted coaching frameworks, plus a few source keys
 * that resolve to a *specific work* by an author already in the corpus — where
 * one framework key would otherwise point at the wrong book. `siegel_brainstorm`
 * resolves Siegel citations on teen pages to Brainstorm (the teen-brain book),
 * while `siegel` stays pointed at The Whole-Brain Child (0–12) for younger pages.
 */
export type AnswerSourceKey = CoachingFramework | 'siegel_brainstorm';

/**
 * The frameworks Hale is permitted to draw parenting-health guidance from —
 * the same grounded corpus the Coach agent cites (apps/worker/prompts/coach.md).
 * Answer-page copy may attribute a claim only to a source in this map; the
 * label + home URL here are what render in each page's citation list, so every
 * cited source is consistent and auditable in one place.
 */
export const FRAMEWORK_SOURCES: Record<
  AnswerSourceKey,
  { label: string; home: string }
> = {
  karp: {
    label: 'Harvey Karp — The Happiest Baby on the Block',
    home: 'https://www.happiestbaby.com',
  },
  ferber: {
    label: "Richard Ferber — Solve Your Child's Sleep Problems",
    home: 'https://en.wikipedia.org/wiki/Ferber_method',
  },
  markham: {
    label: 'Laura Markham — Aha! Parenting',
    home: 'https://www.ahaparenting.com',
  },
  siegel: {
    label: 'Daniel Siegel — The Whole-Brain Child',
    home: 'https://drdansiegel.com/book/the-whole-brain-child/',
  },
  siegel_brainstorm: {
    label: 'Daniel Siegel — Brainstorm: The Power and Purpose of the Teenage Brain',
    home: 'https://drdansiegel.com/book/brainstorm/',
  },
  lansbury: {
    label: 'Janet Lansbury — Elevating Child Care (RIE)',
    home: 'https://www.janetlansbury.com',
  },
  health_canada: {
    label: 'Health Canada',
    home: 'https://www.canada.ca/en/health-canada.html',
  },
  aap: {
    label: 'American Academy of Pediatrics — HealthyChildren.org',
    home: 'https://www.healthychildren.org',
  },
  cps: {
    label: 'Canadian Paediatric Society — Caring for Kids',
    home: 'https://caringforkids.cps.ca',
  },
};
