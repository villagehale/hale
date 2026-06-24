import type { FamilyStage } from '@hale/types';
import { FEED_EPISODE, MILESTONE_EPISODE, NAP_EPISODE } from '~/lib/companion/log-types';

/**
 * Stage→kind gating for the quick-log row, kept free of React and the
 * 'use server' log action so it can be imported by the client component and
 * unit-tested directly (mirrors how log-types is split out from log).
 */

export interface QuickLogChild {
  id: string;
  name: string | null;
  stage: FamilyStage;
}

export type Kind = typeof FEED_EPISODE | typeof NAP_EPISODE | typeof MILESTONE_EPISODE;

/**
 * Feed and nap only make sense for the youngest stages; milestones apply at
 * every age. A teen's parent is never offered a feed log: a kind is shown only
 * when some child supports it, and its child selector lists only eligible kids.
 */
export const STAGE_KINDS: Record<FamilyStage, Kind[]> = {
  newborn: [FEED_EPISODE, NAP_EPISODE, MILESTONE_EPISODE],
  toddler: [FEED_EPISODE, NAP_EPISODE, MILESTONE_EPISODE],
  child: [MILESTONE_EPISODE],
  teenager: [MILESTONE_EPISODE],
};

const KIND_ORDER: Kind[] = [FEED_EPISODE, NAP_EPISODE, MILESTONE_EPISODE];

/** The kind buttons to show: a kind appears when at least one child supports it. */
export function visibleKindsFor(kids: QuickLogChild[]): Kind[] {
  return KIND_ORDER.filter((kind) => kids.some((c) => STAGE_KINDS[c.stage].includes(kind)));
}

/** The children eligible to log a given kind (by stage). */
export function eligibleKidsFor(kids: QuickLogChild[], kind: Kind): QuickLogChild[] {
  return kids.filter((c) => STAGE_KINDS[c.stage].includes(kind));
}
