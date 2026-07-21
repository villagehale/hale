import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  genericSensitiveWhat,
  headerNames,
  itemsChronological,
  strippedWhat,
  weekSubject,
} from './core';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the push renderer. A glanceable title + the first two items, the
 * rest rolled into "+N more". Health is genericized and the child's own name is
 * stripped (the title already names the week's owner), so a lock-screen preview never
 * leaks above the family's privacy level. The deep link rides in `data` for the tap.
 */

const PUSH_PREVIEW = 2;
const ITEM_SEP = ' · ';
const QUIET_BODY = 'A quiet week ahead.';

/** One item as a short "{day} {what}" (day dropped when the item is day-coarse). */
function pushItem(item: WeekPlanItem, children: readonly PlanChild[]): string {
  const what = item.privacySensitive ? genericSensitiveWhat(item) : strippedWhat(item, children);
  const day = dayAbbrev(item.startsAt);
  return day ? `${day} ${what}` : what;
}

export function renderWeeklyPlanPush(
  payload: WeeklyPlanPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  const inPlan = childrenInPlan(payload.items, payload.children);
  const subject = weekSubject(headerNames(inPlan, level, now));
  const title = `${subject} week is ready`;

  const ordered = itemsChronological(payload.items);
  let body: string;
  if (ordered.length === 0) {
    body = QUIET_BODY;
  } else {
    const preview = ordered
      .slice(0, PUSH_PREVIEW)
      .map((i) => pushItem(i, payload.children))
      .join(ITEM_SEP);
    const extra = ordered.length - PUSH_PREVIEW;
    body = extra > 0 ? `${preview} +${extra} more` : preview;
  }

  return { kind: 'push', title, body, data: { deepLink: payload.deepLink } };
}
