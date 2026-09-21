import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';

/**
 * THE ONE SENTENCE Hale uses to ask how a household's weekdays are covered.
 *
 * DETERMINISTIC, and that is not a fallback for a voice that failed. It is the rule
 * every ask that opens a standing question already follows here (checkin/copy.ts,
 * registration/sequence/copy.ts), and the nudge voice CANNOT write it: its skill says
 * "Never write a question. Nothing here needs an answer." Asking it to make an
 * exception for one kind is how the other three kinds start asking questions.
 *
 * Three properties, and each one is a rule rather than a preference:
 *
 * 1. DEICTIC, NOT UNIVERSAL. "Those" points at the send this ask's precondition
 *    matched. "Everything I've found for you" would be a claim about every message
 *    Hale has ever sent, and it is false the moment the coach's activity lane answers
 *    a weekday question or a registration line names a Tuesday programme. An anchor
 *    Hale cannot check is the same defect as an inference Hale should not make: both
 *    assert something Hale does not know. (D23.)
 *
 * 2. THE PAYOFF IS STATED, because the precondition has already paid for it: the ask
 *    does not fire unless a Mon-Fri civic session exists for this family today or
 *    later. It is also what stops the question reading as idle curiosity.
 *
 * 3. THE EITHER/OR COMES LAST, so a bare "yes" is meaningless rather than dangerously
 *    plausible. An earlier draft led with "want me to look at weekdays too?", which
 *    makes "yes" mean `home` and invites the grammar to guess. Fail-closed beats
 *    convenient — the reading this answer produces changes what Hale offers a
 *    household for months.
 */
export function weekdayCareAsk(childPhrase: string): string {
  return `Those are all weekend finds. Is ${childPhrase} home with you during the week, or at daycare? There are weekday drop-ins near you too.`;
}

/** When the child's name is not GSM-7 printable, the ask still goes - generically. The
 * same fallback discipline `childPhrase` keeps for the evening check-in, and for the
 * same reason: one unspellable name must not double what the message costs to send. */
export const GENERIC_WEEKDAY_CHILD_PHRASE = 'your little one';

/** The name this ask may print, or the generic phrase. The caller has ALREADY dropped
 * every 13+ child at the source, so nothing here can reach a teen's name. */
export function weekdayChildPhrase(name: string | null): string {
  if (name === null || name.trim().length === 0) return GENERIC_WEEKDAY_CHILD_PHRASE;
  return isPrintableGsm7Basic(name) ? name : GENERIC_WEEKDAY_CHILD_PHRASE;
}
