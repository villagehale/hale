import { appBaseUrl } from '~/lib/cron/email-compliance';
import { actionTypeLabel } from '~/lib/format/labels';
import type { SpineRefusal } from './approval';
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

/**
 * The link for the three lines that answer "where do my records live" — the doctrine's
 * one stated exception to never pointing a parent at the app (skill audit P0 #4). Every
 * other line here carries what to do next in the thread instead.
 */
function appLink(): string {
  return appBaseUrl();
}

/**
 * The failure-honesty template for a turn that broke having done NOTHING. Two promises:
 * that nothing changed, and that trying again is worth it. Never silence, never a
 * fabricated success (F14 voice rule 5).
 *
 * It used to close with "or use the app", which is the failed turn handed back to the
 * parent to redo by hand. What broke was Hale's end, so what they are owed is Hale
 * trying again — not a second surface to learn on the worst possible message.
 */
export function failureReply(): string {
  return 'Something went wrong on my end - nothing was changed. Try me again in a minute.';
}

/**
 * STATE RECEIPTS — what the parent hears when the approvals spine REFUSES.
 *
 * This is the count-receipt doctrine extended one step: a receipt may be a template
 * when what it carries is a fact about real rows the router just read, and the state a
 * mutator refused on is exactly that. (The founder reviews this class extension; the
 * count-carrying receipts above are its existing half.)
 *
 * They exist because these four refusals used to answer with {@link failureReply}, and
 * all three of its promises were false on this path: nothing went wrong on Hale's end,
 * something HAD changed in the already-answered case (the co-parent answered it), and
 * "try me again in a minute" invites a retry that fails identically — for 24 hours, in
 * the undo case. Keyed by reason so a new refusal cannot ship without its sentence.
 */
const CONFLICT_REPLIES: Record<SpineRefusal, string> = {
  already_resolved: 'Already handled - nothing waiting on you.',
  not_reviewer_approved: "That one hasn't cleared my own checks, so I can't put it through yet.",
  undo_window_expired: "That one's past its undo window.",
  not_reversible: "That one isn't something I can take back.",
  // The genuine breakage: the row vanished mid-turn or came back belonging to another
  // family. Nothing changed and a retry really might work, so the failure line is true.
  unavailable: failureReply(),
};

export function conflictReply(reason: SpineRefusal): string {
  return CONFLICT_REPLIES[reason];
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
 *
 * It stays a BARE "reply YES" at two or more, deliberately. An ordinal here would be the
 * more precise-looking instruction and the more dangerous one: {@link whichOneReply} is
 * the only place an ordinal may be printed, because it and the resolver read the same
 * family-wide, oldest-first array in the same call. This line cannot see that array, so
 * "YES 1" from here would point at whatever is oldest — which, with anything else
 * already pending, is not the change it just drafted. A bare YES round-trips through the
 * numbered list instead: one extra message, and the right row.
 */
export function partialFailureReply(draftCount: number): string {
  const noun = draftCount === 1 ? '1 change' : `${draftCount} changes`;
  const them = draftCount === 1 ? 'it' : 'them';
  return `I couldn't finish that, but I drafted ${noun} waiting for your OK. Reply YES to confirm, or NO to drop ${them}.`;
}

/**
 * The ack sent when a turn outruns its budget. It is a real message in the thread, so
 * it promises only that Hale is working — a parent who hears "on it" and then nothing
 * has been lied to, which is why the failure template always follows a failed turn.
 *
 * FOUNDER REVIEW (tone audit, 2026-08-13): this and {@link FLOOD_REPLY} are fixed bodies
 * under the 2026-08-12 no-preset doctrine. Proposed class: FLOW-CONTROL RECEIPT — neither
 * answers the parent's question; each reports the state of the CONVERSATION (a turn is
 * still running, the queue is behind) and is followed by the real reply. Composing them
 * would also spend a model call on the two paths that are already slow or rate-limited.
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

/** Rule #4: a booking is DRAFTED and held, and the verbs stay honest end-to-end.
 * Approving executes add_to_routine - a pin on the family's week - so the copy
 * promises the week, never the appointment (doctrine: approvals happen in-thread,
 * and Hale does not claim a booking it cannot make; the clinic call is the
 * parent's). */
export function checkupDraftedReply(): string {
  return 'Drafted - reply YES and it goes on your week. Nothing\'s booked until you call the clinic.';
}

export function approvedReceipt(actionType: string): string {
  return `Approved - ${actionTypeLabel(actionType).toLowerCase()}. I'll let you know once it's done.`;
}

export function declinedReceipt(actionType: string): string {
  return `Dropped it - ${actionTypeLabel(actionType).toLowerCase()} won't happen.`;
}

export const UNDONE_RECEIPT = "Undone - I've taken that back off your calendar.";

/**
 * The ack for a captured address (VIL-249).
 *
 * The QUESTION it answers is not here and is not fixed: a placement asks for the
 * address through the dispatch, in words a model composes per send (founder,
 * 2026-08-12 — no preset message bodies; see lib/loop/voice/calendar-invite-voice.ts).
 * This half is the router's own receipt for a write that either happened or did not,
 * which is the class of line the router still authors.
 *
 * The address is asked for ONCE per family, ever (the ledger claim in
 * lib/loop/calendar-invite.ts).
 */

/** The capture ack. It promises only what happened: the address is stored, and the
 * invite that was waiting is on its way when there was one. */
export function emailCapturedReply(inviteSent: boolean): string {
  return inviteSent
    ? "Got it - invites will go there from now on. The last one's on its way."
    : 'Got it - invites will go there from now on.';
}

/**
 * The capture ack when the address was asked for by the INTROS sweep rather than a
 * placement. Same write, different thing waiting on it, so a different receipt: a parent
 * who gave Hale an address to be introduced to another family and hears "invites will go
 * there from now on" has been answered about something they did not ask about.
 *
 * It promises the introduction, not its delivery. The sweep is what sends it, on its next
 * tick — so "I'll make that introduction" is true when this is sent and "it's on its way"
 * would not be.
 */
export const EMAIL_CAPTURED_FOR_INTRO_REPLY =
  "Got it - I'll make that introduction and use this address from now on.";

/** The address belongs to another Hale account. Named rather than swallowed: silently
 * ignoring it would leave the parent waiting for invites that can never arrive. */
export const EMAIL_ALREADY_TAKEN_REPLY =
  "That address is already on another Hale account - text me a different one and I'll use that.";

/**
 * The name capture ack.
 *
 * It does NOT say the name back. Reading a parent's own name to them is the shape of a
 * form confirming a field, and if the recognizer took the wrong word out of their message
 * the echo makes Hale look like it misheard twice. What it says is what changed, which is
 * the only thing a receipt owes.
 *
 * Like the address ack, the QUESTION it answers is composed per send and is not here
 * (lib/channel/identity/ask-voice.ts); this half is the router's receipt for a write.
 */
export const NAME_CAPTURED_REPLY = "Thanks - I'll use that from now on.";

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
 *
 * The overflow is disclosed and points nowhere (skill audit P0 #4). "In the app" was
 * the wrong destination twice over: the grammar refuses an ordinal past
 * {@link MAX_LISTED_APPROVALS} (fast-path.ts), so those rows are unreachable by text —
 * but the list is re-read every turn, so answering the three in front of them is what
 * brings the next three up. The thread does get there; it just gets there in order.
 */
export function whichOneReply(actionTypes: string[]): string {
  const shown = actionTypes.slice(0, MAX_LISTED_APPROVALS);
  const lines = shown.map((type, i) => `${i + 1}. ${actionTypeLabel(type)}`);
  const overflow = actionTypes.length - shown.length;
  const tail = overflow > 0 ? ` (+${overflow} more after these)` : '';
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
