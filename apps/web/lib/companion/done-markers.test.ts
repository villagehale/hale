import { describe, expect, it } from 'vitest';
import { buildDoneByChild, doneForChild } from './done-markers.js';
import { FEED_EPISODE, HEALTH_DONE_EPISODE, MILESTONE_EPISODE } from './log-types.js';

const CHILD_A = 'child-a';
const CHILD_B = 'child-b';

describe('buildDoneByChild', () => {
  it('folds milestone and health_done episodes into per-child done sets', () => {
    const byChild = buildDoneByChild([
      { childId: CHILD_A, episodeType: MILESTONE_EPISODE, payload: { milestone: 'Rolls over' } },
      { childId: CHILD_A, episodeType: HEALTH_DONE_EPISODE, payload: { healthKey: '4-immunization' } },
      { childId: CHILD_B, episodeType: MILESTONE_EPISODE, payload: { milestone: 'Says first words' } },
    ]);

    const a = doneForChild(byChild, CHILD_A);
    expect(a.milestones.has('Rolls over')).toBe(true);
    expect(a.health.has('4-immunization')).toBe(true);
    // A's sets don't leak into B's.
    expect(doneForChild(byChild, CHILD_B).milestones.has('Says first words')).toBe(true);
    expect(doneForChild(byChild, CHILD_B).milestones.has('Rolls over')).toBe(false);
  });

  it('ignores non-marker episodes and unattributed rows', () => {
    const byChild = buildDoneByChild([
      { childId: CHILD_A, episodeType: FEED_EPISODE, payload: { amountMl: 120 } },
      { childId: null, episodeType: MILESTONE_EPISODE, payload: { milestone: 'Walks independently' } },
    ]);
    // A feed doesn't mark anything done; an unattributed milestone has no child to
    // key against, so nothing is recorded.
    expect(doneForChild(byChild, CHILD_A).milestones.size).toBe(0);
    expect(doneForChild(byChild, CHILD_A).health.size).toBe(0);
  });

  it('returns an empty done set for a child with no marks', () => {
    const empty = doneForChild(buildDoneByChild([]), CHILD_A);
    expect(empty.milestones.size).toBe(0);
    expect(empty.health.size).toBe(0);
  });
});
