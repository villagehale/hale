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
  /**
   * REVIEWER STATE, IN PARENT LANGUAGE. It used to read "That one hasn't cleared my own
   * checks, so I can't put it through yet", which is Hale describing its own internals to
   * someone who asked for a thing to happen — the reviewer, the verdict and the gate are
   * all Hale's business and none of them are the parent's. It also, in the one production
   * sighting (2026-08-20), answered a parent who had just accepted a completely different
   * offer, which made a sentence about internal checks the second wrong thing in one text.
   *
   * What is TRUE and sayable: Hale is still looking at it, the parent has nothing to do,
   * and it will come back to them. No timeframe is promised, because a flagged draft waits
   * on a person and "in a minute" would be a clock Hale does not own.
   */
  not_reviewer_approved: "I'm still double-checking that one myself - nothing for you to do yet, I'll come back to you on it.",
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
 * There was an ACK_REPLY here — "On it - one sec.", raced against a five-second timer.
 * Deleted 2026-08-13 (founder decision): silence, then the answer. Two texts for one
 * question is worse on a phone than a pause, and the coach had begun promising parents it
 * would stop sending it — a promise the deterministic timer then broke on its behalf.
 *
 * {@link FLOOD_REPLY} stays. It is a different job: it answers a parent whose hour is
 * spent, and nothing else is coming.
 */

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
 * row was meant — approving a neighbouring action is the failure this avoids.
 *
 * It no longer answers with another ordinal. The parent counted rows and came up short,
 * and handing them the corrected number to retype is a form to fill in twice; saying what
 * is actually waiting lets them answer it in words (the resolver reads them). */
export function outOfRangeReply(pendingCount: number): string {
  return pendingCount === 1
    ? "I've only got one thing waiting on you - tell me if you want it and I'll put it through."
    : `I've only got ${pendingCount} things waiting on you - tell me which one you mean.`;
}

/**
 * The disambiguation — the choices NAMED, and a number beside each one.
 *
 * IT PRINTED NUMBERS, THEN IT STOPPED, AND NOW IT PRINTS THEM AGAIN — with the one thing
 * that was missing both times. The original "1. … 2. … - reply YES 1 or NO 1." was a form
 * to fill in, and dropping it (2026-08-13) was right: a parent should be able to say "the
 * swim one" and be understood. What went with it, unnoticed, was the only cheap answer a
 * tired parent has at 22:00 — and the words that replaced it were not actually read,
 * because nothing recorded that these options had been offered at all. A parent quoted one
 * back verbatim on 2026-08-24 and reached the general coach (VIL-304).
 *
 * So both readings exist now and neither is a keyword: the ordinal, and the parent's own
 * words, resolved against the menu this sentence is minted alongside
 * (router/disambiguation.ts). "Reply 1 or 2, or just say which" is that offer stated
 * plainly — the number is the shortcut, never the grammar, and the sentence says so.
 *
 * THE ORDER IS THE MINT'S ORDER. The row written when this goes out stores the options in
 * exactly the sequence printed here, which is what makes an ordinal point at the option a
 * parent actually read rather than at a position that has since moved.
 *
 * Labels come in already rendered (`actionTypeLabel`), which keeps this function unable to
 * see an action's payload at all (rule #1).
 *
 * The overflow is disclosed and points nowhere (skill audit P0 #4): the list is re-read
 * every turn, so answering the ones in front is what brings the next ones up.
 */
export function whichOneReply(subjects: readonly string[]): string {
  const shown = subjects.slice(0, MAX_LISTED_APPROVALS);
  if (shown.length === 0) {
    // Both callers ask only when they are holding at least two, so this is unreachable —
    // and it THROWS rather than casting the hole away, because the alternative is texting
    // a parent "Which one - undefined?". A thrown turn is re-driven by the drain; a
    // nonsense one is read by a person.
    throw new Error('whichOneReply: nothing to choose between');
  }
  const overflow = subjects.length - shown.length;
  const tail = overflow > 0 ? ` (${overflow} more behind those.)` : '';
  const list = shown.map((subject, i) => `${i + 1}) ${subject}`).join(', ');
  return `Which one - ${list}? Reply ${orJoinNumbers(shown.length)}, or just say which.${tail}`;
}

/** "1, 2 or 3" — the numbers on offer, serial-comma joined like every other Hale list. */
function orJoinNumbers(count: number): string {
  if (count === 1) return '1';
  const head = Array.from({ length: count - 1 }, (_, i) => String(i + 1));
  return `${head.join(', ')} or ${count}`;
}

/**
 * The parent said something Hale could tell was an answer and could not tell WHICH answer,
 * with more than one question open (lib/channel/router/resolve.ts).
 *
 * The same SENTENCE as {@link whichOneReply}, built from a different list. It cannot just
 * be that function: the approvals list is homogeneous and its overflow tail ("3 more
 * behind those") is true because answering the ones in front brings the next ones up.
 * Here the list is heterogeneous, so slicing it by position would offer a parent three
 * calendar adds and silently drop the introduction they were actually answering — and
 * then tell them the introduction was "behind those", which is false. Nothing is behind a
 * drafted action except more drafted actions.
 *
 * So it takes ONE per kind, newest kind last, and never prints an overflow. A parent
 * choosing between "a calendar change" and "meeting the family nearby" can then say which,
 * and the next turn resolves the specific one.
 *
 * IT HANDS BACK WHAT IT PRINTED, not just the sentence. The caller mints those options
 * against the message that carries them (router/disambiguation.ts), and the two must be
 * the same list in the same order or an ordinal points at something the parent never read
 * — so there is one call and one array rather than a rule the two sides both implement.
 */
export function clarifyWhichQuestion<T extends { kind: string; subject: string }>(
  questions: readonly T[],
): { reply: string; shown: readonly T[] } {
  // EVERY KIND FIRST, then fill the remaining slots in order. Taking one per kind and
  // stopping would drop the second of two drafted changes, which is the case the numbered
  // menu handled best; taking the first three in order buries a lone introduction behind a
  // crowded approvals queue. This does neither.
  const seen = new Set<string>();
  const firstOfEachKind = questions.filter((question) => {
    if (seen.has(question.kind)) return false;
    seen.add(question.kind);
    return true;
  });
  const ordered = [...firstOfEachKind, ...questions.filter((q) => !firstOfEachKind.includes(q))];
  const shown = ordered.slice(0, MAX_LISTED_APPROVALS);
  const dropped = ordered.length - shown.length;
  const list = whichOneReply(shown.map((question) => question.subject));
  // Honest and destination-free. NOT "behind those": nothing queues behind an
  // introduction, so the approvals list's own tail would be a false promise here.
  const reply =
    dropped === 0 ? list : `${list} (and ${dropped} other${dropped === 1 ? '' : 's'}.)`;
  return { reply, shown };
}

/**
 * The graceful capability reply, verbatim from the F14 Conversation Design (§3,
 * "Unknown/out-of-scope"). It is what the coach STUB says for every turn until C2
 * (VIL-221) lands — an honest boundary rather than an invented answer.
 */
export function capabilityReply(): string {
  return `That one's past me for now - I'm best at your family's schedule, registrations, and what's on nearby. (For everything I've set up: ${appLink()})`;
}
