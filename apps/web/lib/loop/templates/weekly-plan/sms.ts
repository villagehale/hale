import type { WeekPlanItem } from '@hale/db';
import type { RenderedContent, VoiceOutcome } from '~/lib/channel/types';
import { smsSegments } from '~/lib/channel/sms-segments';
import { assertPoolSize, pickVariant, weeklyOccasion } from '~/lib/channel/variant';
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
 * THE TWO FIXED BODIES, AND WHAT REPLACED THEM.
 *
 * The note that used to sit here said converting these was "a pipeline change, not a copy
 * change", because "the SMS renderer takes no voice parameter at all (payload.ts
 * documents voice as email-only)". BOTH HALVES WERE WRONG. `renderWeeklyPlanSms` takes the
 * whole `WeeklyPlanPayload`, and `payload.voice` is on that shared payload with the
 * instruction "The renderer uses voice fields where present and its deterministic copy
 * where not". `WeekPlanVoice` carries `weekFraming` and `signOff`, which are exactly the
 * two sentences below. Reading them here costs nothing — the composition already happened
 * at the Saturday converge tick.
 *
 * So each slot is a FOLD: the composed sentence first, measured; a three-member pool
 * behind it. The pool is not a fallback in the apologetic sense — it is the reviewed copy,
 * and it rotates on the week's Monday so a family that reads this every Sunday for a year
 * does not read the same sentence fifty-two times.
 *
 * `Reply IDEAS` IS GONE. Grepped across lib/channel: there is NO handler for IDEAS
 * anywhere. It was vocabulary Hale taught and could not honour, which rule 10 forbids
 * outright, and a parent who sent it reached the coach as an unreadable single word.
 *
 * THE QUIET POOL ASKS SOMETHING A BARE YES CANNOT ANSWER (rule 11). "Want ideas for
 * Saturday?" invites a YES that this lane does not own: the approvals resolver claims a
 * bare YES family-wide, and on a week with nothing drafted the parent gets
 * `nothingPendingReply` for an offer Hale itself made. An open question reaches the coach,
 * which can answer it.
 */
const QUIET_ASK_POOL_NAME = 'weekly:quiet';
const QUIET_ASK_POOL: readonly string[] = [
  `A quiet week ${EM_DASH} nothing scheduled yet. What would make Saturday good?`,
  'Nothing on the calendar this week. What should I be looking for?',
  'Your week is clear so far. What kind of thing would suit Saturday?',
];
assertPoolSize(QUIET_ASK_POOL, QUIET_ASK_POOL_NAME);

/** The week that asks nothing — so ZERO questions, not one. */
const PLACED_ASK_POOL_NAME = 'weekly:placed';
const PLACED_ASK_POOL: readonly string[] = [
  'All on your calendar.',
  'Nothing needs you this week.',
  "That's the whole week, already placed.",
];
assertPoolSize(PLACED_ASK_POOL, PLACED_ASK_POOL_NAME);

/**
 * The fold itself, exported so the outcome is assertable.
 *
 * A composed sentence is used only when it clears the SAME mechanical bar the pooled copy
 * is held to: GSM-7 once folded, and the slot's own question count. A model sentence with
 * two questions in it on a surface where a bare YES is claimed by the approvals resolver
 * is the failure the question rule exists for, and the fold is where it is caught. The
 * SEGMENT budget is measured on the whole message by the caller, not here, because a
 * sentence's cost depends on the week it rides with — so `refused:over_segment` is the one
 * outcome this function never returns and the renderer always can.
 *
 * EACH REFUSAL BY ITS OWN NAME (VoiceOutcome, channel/types.ts) rather than one bucket:
 * "the model composed nothing", "the model wrote a character the wire would eat" and "the
 * model asked something this slot does not own" are three different bugs in three
 * different places, and a caller that had to substring-match the body for a sentence it
 * did not choose would be guessing at its own renderer.
 */
export function foldWeeklyVoice(
  composed: string | null | undefined,
  questions: 0 | 1,
): { text: string | null; outcome: VoiceOutcome } {
  const trimmed = composed?.trim() ?? '';
  if (trimmed === '') return { text: null, outcome: 'absent' };
  const safe = gsmSafe(trimmed);
  // BYTE IDENTITY, not "does it look all right": gsmSafe maps a genuinely unmappable
  // character to NOTHING (core.ts), so an emoji leaves the sentence a word short and no
  // counter moves. Comparing the folded string to the composed one is the only check that
  // can see a deletion.
  if (safe !== trimmed) return { text: null, outcome: 'refused:gsm_dropped' };
  if ((safe.match(/\?/g) ?? []).length !== questions) {
    return { text: null, outcome: 'refused:question_count' };
  }
  return { text: safe, outcome: 'used' };
}

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
 * exists to avoid, so the message simply ends with the week. (An empty week is the quiet
 * slot and nothing else, decided by the renderer before it gets here.) */
function approvalAsk(pending: number, drafts: number, placed: string): string | null {
  if (pending === 0) return placed;
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
  familyId: string,
): RenderedContent {
  const inPlan = childrenInPlan(payload.items, payload.children);
  const subject = weekSubject(headerNames(inPlan, level, now));
  // NO `Hale: ` PREFIX (docs/voice.md rule 2). It is a broadcast header on a thread the
  // parent already knows is Hale's; it survives only where the recipient has no way to
  // know who is texting (party/guest-copy.ts).
  const send = (body: string) => gsmSafe(`${subject} week${HEADER_SEP}${body}`);
  const occasion = weeklyOccasion(payload.weekStart);
  const variant = (pool: readonly string[], name: string) =>
    pickVariant(pool, name, familyId, occasion);

  if (payload.items.length === 0) {
    const quiet = foldWeeklyVoice(payload.voice?.weekFraming, 1);
    const voiced = quiet.text === null ? null : send(quiet.text);
    if (voiced !== null && smsSegments(voiced) <= SEGMENT_CAP) {
      return { kind: 'sms', text: voiced, voice: quiet.outcome };
    }
    return {
      kind: 'sms',
      text: send(variant(QUIET_ASK_POOL, QUIET_ASK_POOL_NAME)),
      // A sentence the fold passed and the WEEK then refused is an over-segment refusal
      // and not the fold's own — the quiet slot rides alone, so this is a composer that
      // wrote past three segments of nothing but itself. Reported as itself: "the model
      // asked twice" and "the model wrote a page" are looked at in different places.
      voice: voiced === null ? quiet.outcome : 'refused:over_segment',
    };
  }

  const placed = foldWeeklyVoice(payload.voice?.signOff, 0);
  const pending = pendingCount(payload.items);
  const ask = approvalAsk(
    pending,
    draftedCount(payload.items),
    placed.text ?? variant(PLACED_ASK_POOL, PLACED_ASK_POOL_NAME),
  );
  const tail = ask === null ? '' : `${ITEM_SEP}${ask}`;
  // THE SIGN-OFF SLOT ONLY EXISTS ON A WEEK WITH NOTHING PENDING. Every other week closes
  // on the approval ask, which is a count of rows the mint is holding and never a composed
  // sentence — so there is no outcome to report, and reporting 'absent' there would invent
  // a composer failure on a slot nobody asked for (RenderedContent.voice).
  const signOff: VoiceOutcome | undefined = pending === 0 ? placed.outcome : undefined;

  const linked = send(`${FULL_WEEK_PREFIX}${payload.deepLink}${tail}`);
  if (payload.items.length > SMS_ITEM_CAP) return { kind: 'sms', text: linked, voice: signOff };

  const list = itemsChronological(payload.items)
    .map((i) => smsItem(i, payload.children))
    .join(ITEM_SEP);
  const inline = send(`${list}${tail}`);

  // A week too long to read inline takes the overflow form it already has, rather than
  // a fourth and fifth segment. What survives either way is the ask — and so does the
  // sign-off, because the linked form carries the same tail.
  return {
    kind: 'sms',
    text: smsSegments(inline) <= SEGMENT_CAP ? inline : linked,
    voice: signOff,
  };
}
