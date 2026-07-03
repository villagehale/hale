import type { CompanionDone } from '@hale/types';
import { HEALTH_DONE_EPISODE, MILESTONE_EPISODE } from './log-types.js';

/** A logged episode, narrowed to the fields that mark a curated item done. */
export interface DoneEpisodeRow {
  childId: string | null;
  episodeType: string;
  payload: Record<string, unknown>;
}

/**
 * Folds the family's logged episodes into a per-child "what's already done" map,
 * so companionForChild can flip a milestone / health item to its done state.
 *
 * A `milestone` episode marks a curated milestone done when its payload.milestone
 * matches the curated `what` — a done-tap writes exactly that, so the join is exact
 * by construction (a free-text quick-log that happens to match also counts, which
 * is the intended behaviour: the parent recorded that milestone). A `health_done`
 * episode marks a health item done by its payload.healthKey (healthItemKey).
 *
 * Child-scoped: only episodes attributed to a child contribute (a null-child
 * episode can't be tied to one child's schedule). Pure, no I/O — the DB read and
 * teen-redaction posture live in the caller.
 */
export function buildDoneByChild(episodes: DoneEpisodeRow[]): Map<string, CompanionDone> {
  const byChild = new Map<string, { milestones: Set<string>; health: Set<string> }>();
  const bucket = (childId: string) => {
    let entry = byChild.get(childId);
    if (!entry) {
      entry = { milestones: new Set(), health: new Set() };
      byChild.set(childId, entry);
    }
    return entry;
  };

  for (const ep of episodes) {
    if (ep.childId === null) continue;
    if (ep.episodeType === MILESTONE_EPISODE) {
      const what = ep.payload.milestone;
      if (typeof what === 'string') bucket(ep.childId).milestones.add(what);
    } else if (ep.episodeType === HEALTH_DONE_EPISODE) {
      const key = ep.payload.healthKey;
      if (typeof key === 'string') bucket(ep.childId).health.add(key);
    }
  }

  return byChild;
}

const EMPTY_DONE: CompanionDone = { milestones: new Set(), health: new Set() };

/** The done set for one child, or an empty set when nothing's been marked. */
export function doneForChild(
  byChild: Map<string, CompanionDone>,
  childId: string,
): CompanionDone {
  return byChild.get(childId) ?? EMPTY_DONE;
}
