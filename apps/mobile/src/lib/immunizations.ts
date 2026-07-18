import type { UpcomingHealthItem } from './api-types';

/** The Immunizations page's age-derived view, computed purely from the child's
 * already-teen-redacted companion health lists (no new query, no new data). */
export interface ImmunizationView {
  /** True when NOTHING immunization-related is overdue on the standard schedule —
   * the ONLY condition under which the green "Up to date" banner shows. */
  upToDate: boolean;
  /** Immunization items whose scheduled age recently passed and are not marked done
   * ("was due — done?"). Empty ⇒ upToDate. Soonest-passed order (as delivered). */
  overdue: UpcomingHealthItem[];
  /** The soonest upcoming immunization on the schedule, or null once a child is past
   * the routine immunization schedule. Drives the "Next due" row. */
  nextDue: UpcomingHealthItem | null;
}

/** Just the two health lists the view needs — accepts the full ChildCompanionView. */
type HealthLists = {
  nextHealth: readonly UpcomingHealthItem[];
  recentlyPassedHealth: readonly UpcomingHealthItem[];
};

const isImmunization = (i: UpcomingHealthItem) => i.kind === 'immunization';

/**
 * Derive the Immunizations page state from the child's companion health lists.
 * `recentlyPassedHealth` is already gated to not-done, recently-passed items
 * upstream (@hale/types companionForChild), so an immunization appearing there is
 * genuinely overdue; the banner is "up to date" precisely when none do. `nextHealth`
 * is soonest-first, so the first immunization in it is the next due.
 */
export function immunizationView(child: HealthLists): ImmunizationView {
  const overdue = child.recentlyPassedHealth.filter(isImmunization);
  const nextDue = child.nextHealth.find(isImmunization) ?? null;
  return { upToDate: overdue.length === 0, overdue, nextDue };
}
