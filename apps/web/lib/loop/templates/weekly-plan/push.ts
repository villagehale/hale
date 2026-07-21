import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  genericSensitiveWhat,
  headerNames,
  itemsChronological,
  partitionByNeed,
  strippedWhat,
  weekSubject,
} from './core';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the push renderer.
 *
 * Design pass (two-rubric): a lock-screen preview has no typography to speak of, so
 * the rubric lever here is structure — the body LEADS with the decision (what needs
 * the parent's OK) and previews those items, rather than a flat "here's your week".
 * When nothing's pending it opens "All set" (the handled state). Health is genericized
 * and the child's own name stripped (the title already names the week's owner), so a
 * preview never leaks above the family's privacy level. The deep link rides in `data`.
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

/** Up to two items chronological, with a "+N more" tail for the rest. */
function preview(items: readonly WeekPlanItem[], children: readonly PlanChild[]): string {
  const ordered = itemsChronological(items);
  const shown = ordered
    .slice(0, PUSH_PREVIEW)
    .map((i) => pushItem(i, children))
    .join(ITEM_SEP);
  const extra = ordered.length - PUSH_PREVIEW;
  return extra > 0 ? `${shown} +${extra} more` : shown;
}

export function renderWeeklyPlanPush(
  payload: WeeklyPlanPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  const inPlan = childrenInPlan(payload.items, payload.children);
  const subject = weekSubject(headerNames(inPlan, level, now));
  const title = `${subject} week is ready`;

  const { pending, handled } = partitionByNeed(payload.items);
  let body: string;
  if (payload.items.length === 0) {
    body = QUIET_BODY;
  } else if (pending.length > 0) {
    body = `${pending.length} need your OK${ITEM_SEP}${preview(pending, payload.children)}`;
  } else {
    body = `All set${ITEM_SEP}${preview(handled, payload.children)}`;
  }

  return { kind: 'push', title, body, data: { deepLink: payload.deepLink } };
}
