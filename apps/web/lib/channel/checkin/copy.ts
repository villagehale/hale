import type { ReplyLanguage } from '~/lib/channel/language';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { withOptOut } from '~/lib/channel/opt-out';

/**
 * VIL-353 · every word Hale texts in the evening check-in lane, in one file.
 *
 * This is the SPEC, not a template layer (the contract the intake, caregiver and
 * co-parent copy all keep): the tests assert these strings, so a change to what a parent
 * is asked every night of their life is a reviewable diff.
 *
 * PAYOFF FIRST, THEN EXACTLY ONE QUESTION, and a miss is never punished. That shape is
 * Finch's, and it is the only thing that separates a ritual from a survey — the moment
 * this message asks two things, or scolds a parent for a quiet Tuesday, it becomes the
 * thing they mute.
 *
 * THE ASK IS ENGLISH-ONLY, and that is an honest limit rather than an oversight. Hale
 * reads the language of the message in front of it (language.ts) and has no other source:
 * `families.primary_language` exists on the table and is written by nothing, so a lookup
 * there would be a bilingual feature that is always English. A proactive message has no
 * message in front of it. The REPLIES below are bilingual, because by then the parent has
 * written something and the ordinary per-message rule applies.
 *
 * GSM-7 AND ONE SEGMENT, both asks measured against the FULL opt-out line (`\n\n` +
 * 'Reply STOP to opt out.'), which is the conservative bound for both of its forms.
 * A curly apostrophe or an em dash anywhere here halves the budget to 70 and splits a
 * nightly message into two, every night. copy.test.ts holds the line.
 */

/**
 * The ledger's `template_key` for each of the two messages this lane sends UNPROMPTED, and
 * the one thing that tells them apart afterwards. `checkin:ask` OPENS a standing question;
 * `checkin:weekly` announces a cadence change and asks nothing. The reply lane reads the
 * key, so a parent's next text is never filed against a notice.
 */
export const CHECK_IN_ASK_TEMPLATE_KEY = 'checkin:ask';
export const CHECK_IN_STEP_DOWN_TEMPLATE_KEY = 'checkin:weekly';

/**
 * The ledger's `template_key` for every ACK this lane sends back — the thank-you, the
 * refusal, and the three cadence receipts.
 *
 * A reply row is written by the router and not by this lane, so without a name on it the
 * lane's own last word is indistinguishable from the coach's: `lastCheckInMessageToParent`
 * would see the ask, see the ack sitting on top of it, and conclude that somebody else had
 * the floor. One key for all five, because the only question anyone asks of it is "was the
 * last thing this parent heard from Hale ours".
 */
export const CHECK_IN_ACK_TEMPLATE_KEY = 'checkin:ack';

/** What the question calls the children when it cannot name them. */
export const GENERIC_CHILD_PHRASE = 'the kids';

/**
 * The children the question may name: their first names, or {@link GENERIC_CHILD_PHRASE}.
 *
 * The caller has ALREADY dropped every 13+ child (rule #1, stripped at the source the way
 * the nudge does it), so a household whose only children are teenagers arrives here with
 * an empty list and is answered generically — which is the point: the fallback exists so
 * that a teen's absence from this sentence is indistinguishable from having no children
 * on file.
 */
export function childPhrase(names: readonly string[]): string {
  if (names.length === 0) return GENERIC_CHILD_PHRASE;
  const joined =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
  // A name Hale cannot spell in GSM-7 would cost the whole message its budget twice over.
  return isPrintableGsm7Basic(joined) ? joined : GENERIC_CHILD_PHRASE;
}

/**
 * The first evening question this family has ever been asked.
 *
 * It is the only one that prints the keywords, because it is the only one that has to:
 * the parent has not consented to a nightly ritual, so the message that starts one has to
 * carry both ways out of it in the same breath.
 */
function firstCheckInAsk(phrase: string): string {
  return `Quick one before the day's gone: how did today go with ${phrase}? One line is plenty. Reply LESS for weekly, or NO to skip these.`;
}

/** Every evening after the first. Nine words and a door left open. */
function laterCheckInAsk(phrase: string): string {
  return `How did today go with ${phrase}? One line is plenty.`;
}

/**
 * The question, named where it fits and generic where it does not.
 *
 * THE FOLD IS MEASURED, NOT GUESSED. A maximum name length would be a second copy of the
 * budget that the copy above can silently outgrow; composing and then asking the segment
 * counter is the same question asked once, of the string that actually goes on the wire.
 * A household of long names loses the names, never the segment — this message is sent
 * every night, so a second segment is a second segment forever.
 */
export function composeCheckInAsk(input: {
  first: boolean;
  childNames: readonly string[];
}): string {
  const write = input.first ? firstCheckInAsk : laterCheckInAsk;
  const named = write(childPhrase(input.childNames));
  return fitsOneSegment(named) ? named : write(GENERIC_CHILD_PHRASE);
}

/**
 * Three evenings of silence, said out loud rather than acted on quietly.
 *
 * A product that simply stopped asking would be indistinguishable from one that broke,
 * and a parent who was only busy would never learn they could have it back.
 *
 * IT SAYS "REPLY DAILY", NOT "ANY EVENING", because the second is a duration and the
 * duration is not unlimited: this lane holds its own words for thirty days after it last
 * spoke (CHECK_IN_REOFFER_DAYS), and a household that goes dormant after this notice
 * eventually falls outside that. The sentence gives the word without the promise.
 */
export const CHECK_IN_STEP_DOWN = "I'll check in weekly instead - reply DAILY to switch back.";

/** The parent asked for less. */
export const CHECK_IN_WEEKLY_ACK: Record<ReplyLanguage, string> = {
  en: 'Got it - weekly from now on. Reply DAILY to switch back.',
  fr: 'Entendu - une fois par semaine. Répondez DAILY pour revenir.',
};

/** The parent asked for none. No bargaining, no "are you sure". */
export const CHECK_IN_OFF_ACK: Record<ReplyLanguage, string> = {
  en: 'Okay - no more evening check-ins. Text me whenever you like.',
  fr: "D'accord - plus de nouvelles du soir. Écrivez-moi quand vous voulez.",
};

/** The parent asked for it back. */
export const CHECK_IN_DAILY_ACK: Record<ReplyLanguage, string> = {
  en: 'Back to nightly then. Reply LESS or NO to change that.',
  fr: 'De retour tous les soirs. Répondez LESS ou NO pour changer.',
};

/**
 * The parent told Hale about their day and Hale kept it.
 *
 * It names what the note is FOR, because a memory a parent cannot see the use of is a
 * memory they are right to resent — and it names the way out again, since this is the
 * message a parent reads most often.
 */
export const CHECK_IN_NOTED_ACK: Record<ReplyLanguage, string> = {
  en: "Noted - thanks. I'll keep it in mind for the weekend picks. Reply NO to drop these.",
  fr: "Noté - merci. J'y penserai pour les suggestions du week-end. Répondez NO pour ne plus en recevoir.",
};

/**
 * The parent said something Hale will not keep (see notes.ts).
 *
 * IT DOES NOT SAY WHY, and that is deliberate: naming the category back at them ("I don't
 * keep health details") would repeat the sensitive thing in a message that sits on a lock
 * screen. It says what happened, which is the only part they need.
 */
export const CHECK_IN_NOT_KEPT_ACK: Record<ReplyLanguage, string> = {
  en: "Thanks for telling me. I won't keep that one on file.",
  fr: "Merci de me l'avoir dit. Je ne garde pas celle-là.",
};

/**
 * Whether a proactive body still fits one segment once the opt-out rides on it.
 *
 * Measured against the FULL line, which is the conservative bound for both of its forms
 * (opt-out.ts) — the short one can only ever be smaller.
 */
export function fitsOneSegment(body: string): boolean {
  return smsSegments(withOptOut(body, 'full')) === 1;
}
