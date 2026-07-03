import type { CompanionView, MilestoneStatus } from '@hale/types';

/**
 * Plan ("your week") pure core: fold each child's live companion view into the
 * forward-looking items the week view shows — the soonest upcoming health item,
 * and the milestone window that's open right now. I/O-free so it's unit-testable
 * without a request; the page passes the loaded companion views in.
 *
 * Per child we surface at most one health item (the soonest) and at most one
 * milestone (the one in its window now) so the week stays scannable rather than a
 * full timeline — the Companion page is the full per-child view, which each card
 * links to.
 */

export interface PlanChildItem {
  /** Stable list key. */
  key: string;
  /** The child's given name, or null on a teen-redacted line (no name shown). */
  childName: string | null;
  /** Short category label shown as the card eyebrow. */
  kindLabel: string;
  what: string;
  /** Human "when" phrase, e.g. "this week" / "in ~3 months". Empty on a locked line. */
  when: string;
  /** True on the single locked line that stands in for a 13+ teen's items (rule
   * #1, policy 3): the parent sees THAT a plan exists, never its content, never a
   * name — one locked line, never a silent drop. */
  teenRedacted?: boolean;
}

/** The single locked line a 13+ teen collapses to — no name, no content, no "when". */
const TEEN_PLAN_LOCKED_WHAT = 'a plan for your teen — private';

interface NamedChild extends CompanionView {
  id: string;
}

const HEALTH_KIND_LABEL: Record<CompanionView['nextHealth'][number]['kind'], string> = {
  immunization: 'immunization',
  well_child_visit: 'checkup',
};

/** Whole-weeks-until → a calm human phrase. */
export function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'this week';
  if (dueInWeeks === 1) return 'next week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** The milestone whose typical window is open now (timing === 'in_window'), if any. */
function currentMilestone(milestones: readonly MilestoneStatus[]): MilestoneStatus | null {
  return milestones.find((m) => m.timing === 'in_window') ?? null;
}

export function planChildItems(children: ReadonlyArray<NamedChild>): PlanChildItem[] {
  const items: PlanChildItem[] = [];

  for (const child of children) {
    // Rule #1 (policy 3): a 13+ teen's health/milestone items are their private
    // content — collapse to ONE locked line that still COUNTS toward the week, so
    // the parent knows something is there without seeing it or the teen's name.
    // Age-derived (deriveStage), never the classifier flag.
    if (child.stage === 'teenager') {
      items.push({
        key: `${child.id}-teen`,
        childName: null,
        kindLabel: 'private',
        what: TEEN_PLAN_LOCKED_WHAT,
        when: '',
        teenRedacted: true,
      });
      continue;
    }

    const childName = child.name ?? 'your child';

    const health = child.nextHealth[0];
    if (health) {
      items.push({
        key: `${child.id}-health`,
        childName,
        kindLabel: HEALTH_KIND_LABEL[health.kind],
        what: health.what,
        when: duePhrase(health.dueInWeeks),
      });
    }

    const milestone = currentMilestone(child.milestones);
    if (milestone) {
      items.push({
        key: `${child.id}-milestone`,
        childName,
        kindLabel: 'milestone',
        what: milestone.what,
        when: 'around now',
      });
    }
  }

  return items;
}
