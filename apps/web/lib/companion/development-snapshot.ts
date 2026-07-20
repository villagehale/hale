import type { CompanionView } from '@hale/types';

type MilestoneStatus = CompanionView['milestones'][number];
export type MilestoneArea = MilestoneStatus['area'];

/** The five development domains, in a fixed display order, with the parent-facing
 * label + the design-handoff donut colour (§2 data-viz). Kept here so the donut and
 * its legend read the SAME list — a domain can never appear in one and not the
 * other. Milestone `area` maps to a domain (social → "Social & emotional",
 * independence → "Adaptive"). */
export const DEVELOPMENT_DOMAINS: readonly {
  area: MilestoneArea;
  label: string;
}[] = [
  { area: 'cognitive', label: 'Cognitive' },
  { area: 'language', label: 'Language' },
  { area: 'motor', label: 'Motor' },
  { area: 'social', label: 'Social & emotional' },
  { area: 'independence', label: 'Adaptive' },
];

export interface DomainProgress {
  area: MilestoneArea;
  label: string;
  total: number;
  done: number;
}

/**
 * The Overview "Development snapshot": milestone progress grouped by domain. This is
 * REAL per-child data (each domain's count of curated milestones for the stage and
 * how many the parent has marked done) — never a fabricated distribution. Only
 * domains that HAVE milestones this stage appear (so a stage without, say, a
 * cognitive milestone doesn't render an empty slice). `done` is the count marked
 * across all domains; when it is 0 the view shows the honest empty ring rather than
 * inventing a shape.
 */
export interface DevelopmentSnapshot {
  domains: DomainProgress[];
  total: number;
  done: number;
}

export function buildDevelopmentSnapshot(
  milestones: readonly MilestoneStatus[],
): DevelopmentSnapshot {
  const domains: DomainProgress[] = [];
  for (const { area, label } of DEVELOPMENT_DOMAINS) {
    const inArea = milestones.filter((m) => m.area === area);
    if (inArea.length === 0) continue;
    domains.push({
      area,
      label,
      total: inArea.length,
      done: inArea.filter((m) => m.done).length,
    });
  }
  return {
    domains,
    total: milestones.length,
    done: milestones.filter((m) => m.done).length,
  };
}
