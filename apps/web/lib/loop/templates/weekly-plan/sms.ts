import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent } from '~/lib/channel/types';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  draftedCount,
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
// The budget in the module header, enforced rather than assumed. The item cap is a
// proxy for it and a loose one: eight items whose titles are the long real ones the
// registration corpus carries render four segments, and nothing measured that.
const SEGMENT_CAP = 3;
const FULL_WEEK_PREFIX = 'Full week: ';

/**
 * FOUNDER REVIEW (tone audit, 2026-08-13): these two are FIXED BODIES on a weekly
 * surface, so under the 2026-08-12 "no preset message bodies" doctrine they need a class
 * or a composer. Proposed class: STATE RECEIPT — each is a one-line report of the week's
 * shape (nothing scheduled / everything placed) with no claim beyond it, the same class
 * as the approval ask below, which the doctrine's count-carrying exception already
 * covers. Left as-is tonight rather than composed: the SMS renderer takes no voice
 * parameter at all (payload.ts documents voice as email-only), so converting them is a
 * pipeline change, not a copy change.
 */
const QUIET_ASK =
  `A quiet week ${EM_DASH} nothing scheduled yet. Want ideas for Saturday? Reply IDEAS.`;
const PLACED_ASK = 'All on your calendar.';

const PENDING_TAIL = 'or tell me what to change.';

/**
 * The approval ask — the one line in this message that instructs, so it is the one that
 * has to be true about the ROUTER as well as about the week.
 *
 * The count is DRAFTS (`draftedCount`), the rows the placement mint holds and the only
 * rows a texted YES can resolve. It used to be every item that needed anything, which
 * counted undated checkups and "shall we?" suggestions that never become approvable —
 * and then told the parent one word would put all of them on their calendar.
 *
 * At two or more, the instruction says what actually happens: `resolveApproval`
 * auto-approves a bare YES only when EXACTLY ONE row is pending and otherwise answers by
 * NAMING the choices in one sentence (router/copy.ts `whichOneReply`). It does not quote
 * an ordinal, and that was true before the menu went and is true for a second reason
 * now: the pending list is family-wide and oldest-first, so this week's drafts are not at
 * positions 1..n whenever anything older is still waiting, and an ordinal from here would
 * point at somebody else's row.
 *
 * A bare "reply YES" is still printed and still fine. "Yes" is English; "YES 1" and
 * "YES INTRO" were vocabulary, and those are what the 2026-08-13 arc removed.
 */
function pendingAsk(drafts: number): string {
  const instruction =
    drafts === 1 ? 'reply YES to add it' : "reply YES and I'll take them one at a time";
  return `${drafts} drafted for your calendar ${EM_DASH} ${instruction}, ${PENDING_TAIL}`;
}

/** The closing line for a week that HAS items — and absent when the week asks
 * something Hale cannot turn into a one-word approval (a decision, an undated
 * appointment): an ask with no answerable row is the misdirection this whole line
 * exists to avoid, so the message simply ends with the week. (An empty week is
 * QUIET_ASK and nothing else, decided by the renderer before it gets here.) */
function approvalAsk(pending: number, drafts: number): string | null {
  if (pending === 0) return PLACED_ASK;
  if (drafts === 0) return null;
  return pendingAsk(drafts);
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
  const send = (body: string) => gsmSafe(`Hale: ${subject} week${HEADER_SEP}${body}`);

  if (payload.items.length === 0) return { kind: 'sms', text: send(QUIET_ASK) };

  const ask = approvalAsk(pendingCount(payload.items), draftedCount(payload.items));
  const tail = ask === null ? '' : `${ITEM_SEP}${ask}`;

  const linked = send(`${FULL_WEEK_PREFIX}${payload.deepLink}${tail}`);
  if (payload.items.length > SMS_ITEM_CAP) return { kind: 'sms', text: linked };

  const list = itemsChronological(payload.items)
    .map((i) => smsItem(i, payload.children))
    .join(ITEM_SEP);
  const inline = send(`${list}${tail}`);

  // A week too long to read inline takes the overflow form it already has, rather than
  // a fourth and fifth segment. What survives either way is the ask.
  return { kind: 'sms', text: smsSegments(inline) <= SEGMENT_CAP ? inline : linked };
}
