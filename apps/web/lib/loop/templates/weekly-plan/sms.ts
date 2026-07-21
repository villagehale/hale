import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  genericSensitiveWhat,
  gsmSafe,
  headerNames,
  itemsChronological,
  pendingCount,
  strippedWhat,
  timeLabel,
  weekSubject,
} from './core';
import type { PlanChild, WeeklyPlanPayload } from './payload';

/**
 * VIL-218 · B2 — the SMS renderer. The tightest channel: ≤3 segments, emoji + name
 * stripped, health genericized. Authored with the design's typographic punctuation
 * (em-dash header separator, middle-dot item separator) and folded to GSM-7 once at
 * the end via gsmSafe, which is what keeps a full week inside the segment budget.
 */

const EM_DASH = '—';
const MIDDLE_DOT = '·';
const HEADER_SEP = ` ${EM_DASH} `;
const ITEM_SEP = ` ${MIDDLE_DOT} `;

// Beyond this many items the inline list is replaced by the single "Full week" link
// (compose caps at 8; this is the defensive overflow).
const SMS_ITEM_CAP = 8;
const FULL_WEEK_PREFIX = 'Full week: ';

const QUIET_ASK =
  `A quiet week ${EM_DASH} nothing scheduled yet. Want ideas for Saturday? Reply IDEAS.`;
const PLACED_ASK = 'All on your calendar.';

const PENDING_TAIL = 'to your calendar, or tell me what to change.';

function pendingAsk(pending: number): string {
  const who = pending === 2 ? 'both' : 'them';
  return `${pending} need your OK ${EM_DASH} reply YES to add ${who} ${PENDING_TAIL}`;
}

/** The always-present closing invitation, chosen by the week's shape. */
function approvalAsk(itemCount: number, pending: number): string {
  if (itemCount === 0) return QUIET_ASK;
  if (pending === 0) return PLACED_ASK;
  return pendingAsk(pending);
}

/** One item as "{day}: {what} {time}" (day/time dropped when the item is day-coarse). */
function smsItem(item: WeekPlanItem, children: readonly PlanChild[]): string {
  const what = item.privacySensitive ? genericSensitiveWhat(item) : strippedWhat(item, children);
  const day = dayAbbrev(item.startsAt);
  const time = timeLabel(item.startsAt);
  const parts: string[] = [];
  if (day) parts.push(`${day}:`);
  parts.push(what);
  if (time) parts.push(time);
  return parts.join(' ');
}

export function renderWeeklyPlanSms(
  payload: WeeklyPlanPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  const inPlan = childrenInPlan(payload.items, payload.children);
  const subject = weekSubject(headerNames(inPlan, level, now));
  const pending = pendingCount(payload.items);
  const ask = approvalAsk(payload.items.length, pending);

  let body: string;
  if (payload.items.length === 0) {
    body = ask;
  } else if (payload.items.length > SMS_ITEM_CAP) {
    body = `${FULL_WEEK_PREFIX}${payload.deepLink}${ITEM_SEP}${ask}`;
  } else {
    const list = itemsChronological(payload.items)
      .map((i) => smsItem(i, payload.children))
      .join(ITEM_SEP);
    body = `${list}${ITEM_SEP}${ask}`;
  }

  const text = gsmSafe(`Hale: ${subject} week${HEADER_SEP}${body}`);
  return { kind: 'sms', text };
}
