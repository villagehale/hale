import { appBaseUrl } from '~/lib/cron/email-compliance';
import { actionTypeLabel } from '~/lib/format/labels';
import { MAX_LISTED_APPROVALS } from './fast-path';

/**
 * VIL-220 · C1 — every line the router itself can send. Deterministic copy only: what
 * the coach says is C2's, what intake says is M2's, what a caregiver hears is M6's.
 *
 * Written to the F14 voice rules — three sentences at most, one idea, never a dead end,
 * and never a rendered piece of household detail. Every label below comes from
 * `actionTypeLabel`, which is derived from the action TYPE and never from its payload,
 * so a numbered list can name a teenager's drafted action without disclosing what it
 * says (rule #1).
 */

/** The app link every honest dead-end points at. */
function appLink(): string {
  return appBaseUrl();
}

/**
 * The failure-honesty template for a turn that broke having done NOTHING. Two promises:
 * that nothing changed, and where to go instead. Never silence, never a fabricated
 * success (F14 voice rule 5).
 */
export function failureReply(): string {
  return `Something went wrong on my end - nothing was changed. Try again or use the app: ${appLink()}`;
}

/**
 * The same honesty for a turn that broke AFTER it drafted (VIL-260).
 *
 * The drafts are real rows in the approvals queue, so "nothing was changed" would be a
 * false statement about a write the parent can see in the app — and a parent who has not
 * been told they exist cannot answer them, which is how a later unrelated "yes" ends up
 * approving one. It says the count and never what the drafts ARE: the type alone can
 * name a teenager's action, and this line is not the place for either (rule #1).
 *
 * Plain ASCII, no typographic dash: this is the longest line the router sends, and one
 * em dash flips the whole message to UCS-2 (70 characters a segment) and turns a
 * one-segment reply into three. The coach skill states the same rule for the same reason.
 */
export function partialFailureReply(draftCount: number): string {
  const noun = draftCount === 1 ? '1 change' : `${draftCount} changes`;
  return `I couldn't finish that, but I drafted ${noun} waiting for your OK. Reply YES to confirm, or check the app: ${appLink()}`;
}

/**
 * The ack sent when a turn outruns its budget. It is a real message in the thread, so
 * it promises only that Hale is working — a parent who hears "on it" and then nothing
 * has been lied to, which is why the failure template always follows a failed turn.
 */
export const ACK_REPLY = 'On it - one sec.';

/**
 * Flood control's answer. It is deliberately warm and gives no number: a parent who is
 * texting fast is usually stressed, not abusing anything, and quoting a rate limit at
 * them would be the wrong register entirely.
 */
export const FLOOD_REPLY = "Give me a moment - I'm still catching up on your last few texts.";

/**
 * The two acknowledgements M8's reply handler owes a parent. They live here rather than
 * in lib/health/copy.ts because M8 shipped its handler with no caller — C1 is the first
 * one, so the outbound half of that exchange is C1's to write.
 *
 * The "done" line promises nothing was checked, because nothing was: Hale does not hold
 * the record it would verify against, and a reply implying otherwise would be the kind
 * of quiet fabrication rule #5's failure-honesty exists to forbid.
 */
export function healthDoneReply(): string {
  return "Filed - I won't raise that one again.";
}

/** Rule #4: a booking is DRAFTED and held. The copy names the hold explicitly so a
 * parent never believes an appointment exists because they texted "yes". */
export function checkupDraftedReply(): string {
  return `Drafted it for you to approve - nothing's booked until you say so: ${appLink()}`;
}

export function approvedReceipt(actionType: string): string {
  return `Approved - ${actionTypeLabel(actionType).toLowerCase()}. I'll let you know once it's done.`;
}

export function declinedReceipt(actionType: string): string {
  return `Dropped it - ${actionTypeLabel(actionType).toLowerCase()} won't happen.`;
}

export const UNDONE_RECEIPT = "Undone - I've taken that back off your calendar.";

export function nothingPendingReply(): string {
  return `Nothing's waiting on your approval right now. Everything I've set up is here: ${appLink()}`;
}

export function nothingToUndoReply(): string {
  return `Nothing to undo from the last day. Your full history is here: ${appLink()}`;
}

/** An ordinal past the end of the list. Says the real count rather than guessing which
 * row was meant — approving a neighbouring action is the failure this avoids. */
export function outOfRangeReply(pendingCount: number): string {
  const noun = pendingCount === 1 ? 'one' : `${pendingCount}`;
  return `I've only got ${noun} waiting on you - reply YES 1 for the first.`;
}

/**
 * The disambiguation. This is the ONLY place an ordinal is ever printed, so the list
 * order here IS the order `resolveApproval` resolves against; they are built from the
 * same array in the same call, which is what keeps "YES 2" pointing at the row the
 * parent actually read.
 */
export function whichOneReply(actionTypes: string[]): string {
  const shown = actionTypes.slice(0, MAX_LISTED_APPROVALS);
  const lines = shown.map((type, i) => `${i + 1}. ${actionTypeLabel(type)}`);
  const overflow = actionTypes.length - shown.length;
  const tail =
    overflow > 0 ? ` (+${overflow} more in the app: ${appLink()})` : '';
  return `Which one? ${lines.join(' ')} - reply YES 1 or NO 1.${tail}`;
}

/**
 * The graceful capability reply, verbatim from the F14 Conversation Design (§3,
 * "Unknown/out-of-scope"). It is what the coach STUB says for every turn until C2
 * (VIL-221) lands — an honest boundary rather than an invented answer.
 */
export function capabilityReply(): string {
  return `That one's past me for now - I'm best at your family's schedule, registrations, and what's on nearby. (For everything I've set up: ${appLink()})`;
}
