import { describe, expect, it } from 'vitest';
import {
  DIAPER_EPISODE,
  FEED_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import { eligibleKidsFor, type QuickLogChild, visibleKindsFor } from './quick-log-kinds.js';

/**
 * The quick-log affordance is stage-gated: feed/nap/diaper are newborn-oriented and
 * must NOT be offered to a family with no child young enough for them (defect: /home
 * showed "log a feed"/"log a nap" for toddler/child/teen-only families). Milestone
 * applies at every age. `stage` is the child's live derived FamilyStage.
 */

function child(stage: QuickLogChild['stage']): QuickLogChild {
  return { id: `c-${stage}`, name: stage, stage };
}

describe('visibleKindsFor — feed/nap/diaper only when a child is young enough', () => {
  it('offers feed + nap + diaper + milestone when there is a newborn or toddler', () => {
    expect(visibleKindsFor([child('newborn')])).toEqual([
      FEED_EPISODE,
      NAP_EPISODE,
      DIAPER_EPISODE,
      MILESTONE_EPISODE,
    ]);
    expect(visibleKindsFor([child('toddler')])).toContain(FEED_EPISODE);
    expect(visibleKindsFor([child('toddler')])).toContain(NAP_EPISODE);
    expect(visibleKindsFor([child('toddler')])).toContain(DIAPER_EPISODE);
  });

  it('offers ONLY milestone for a child-stage-only family — no feed, no nap', () => {
    expect(visibleKindsFor([child('child')])).toEqual([MILESTONE_EPISODE]);
  });

  it('offers ONLY milestone for a teen-only family — no feed, no nap', () => {
    expect(visibleKindsFor([child('teenager')])).toEqual([MILESTONE_EPISODE]);
  });

  it('shows feed/nap for a mixed family, but only the young child is eligible to log them', () => {
    const kids = [child('newborn'), child('teenager')];
    expect(visibleKindsFor(kids)).toContain(FEED_EPISODE);
    expect(eligibleKidsFor(kids, FEED_EPISODE)).toEqual([child('newborn')]);
    expect(eligibleKidsFor(kids, MILESTONE_EPISODE)).toHaveLength(2);
  });
});
