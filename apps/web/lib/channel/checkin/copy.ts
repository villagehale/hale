import type { ReplyLanguage } from '~/lib/channel/language';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { withOptOut } from '~/lib/channel/opt-out';
import { assertPoolSize, pickVariant } from '~/lib/channel/variant';

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

/**
 * The pool names — the SELECTOR's keys, not the ledger's.
 *
 * They are in the rotation offset so that two pools firing on the same evening do not
 * advance in lockstep: without them, tonight's ask and tonight's ack would be the same
 * pairing for the life of the household. They are deliberately NOT the template keys
 * above — a template key is a fact the reply lane reads back off a row, and re-using one
 * here would make a pool rename look like a ledger change.
 */
const LATER_ASK_POOL_NAME = 'checkin:later';
const NOTED_ACK_POOL_NAME = 'checkin:ack';

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

/**
 * Every evening after the first — FIVE ways of asking it, and the family reads one per
 * night in rotation (variant.ts).
 *
 * This is the message a household reads more often than any other message Hale sends, so
 * one sentence forever is the thing that makes a ritual into a form. Five is the founder's
 * number: a five-evening cycle, twenty sentences across the four pools, all reviewed.
 *
 * WHAT BINDS EVERY MEMBER, and all four are tests (copy.test.ts):
 *   · GSM-7, and one segment MEASURED with the full opt-out line on it;
 *   · exactly one "?" — a second question is one a parent's reply cannot answer (D14);
 *   · rule 11 — no member may be answerable by a bare yes or no. `readCadenceWord` maps a
 *     whole-string "no" to cadence OFF before anything else reads the message, so "Did
 *     she make it to swim?" is a question that turns the evening off when answered
 *     honestly;
 *   · no two members score 0.65 or more on the word-set overlap the landing copy is held
 *     to — five sentences with a synonym swapped is not a pool.
 *
 * The first member is the sentence this lane shipped with, kept deliberately: a reviewer
 * reading a diff of this file should still see real copy they recognise.
 */
const LATER_ASK_POOL: ReadonlyArray<(phrase: string) => string> = [
  (phrase) => `How did today go with ${phrase}? One line is plenty.`,
  (phrase) => `What was the best bit of today with ${phrase}?`,
  (phrase) => `How was today with ${phrase}? Even a word helps.`,
  (phrase) => `How did ${phrase} do today? A word or two is plenty.`,
  (phrase) => `What stood out today with ${phrase}?`,
];
assertPoolSize(LATER_ASK_POOL, LATER_ASK_POOL_NAME);

/**
 * The question, named where it fits and generic where it does not.
 *
 * THE FOLD IS MEASURED, NOT GUESSED. A maximum name length would be a second copy of the
 * budget that the copy above can silently outgrow; composing and then asking the segment
 * counter is the same question asked once, of the string that actually goes on the wire.
 * A household of long names loses the names, never the segment — this message is sent
 * every night, so a second segment is a second segment forever.
 *
 * THE FIRST ASK IS NOT POOLED and never will be: it is the only one that prints the
 * keywords, it happens once in a lifetime, and a once-ever message has no repetition to
 * cure. It is also the positive control that the pool work did not eat the one message
 * that must not vary.
 */
export function composeCheckInAsk(input: {
  first: boolean;
  childNames: readonly string[];
  /** Whose rotation this is. */
  familyId: string;
  /** The family-local day number — `nightlyOccasion(now, timeZone)`. */
  occasion: number;
}): string {
  const write = input.first
    ? firstCheckInAsk
    : pickVariant(LATER_ASK_POOL, LATER_ASK_POOL_NAME, input.familyId, input.occasion);
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
 * The parent told Hale about their day and Hale kept it — FIVE ways, in BOTH languages.
 *
 * Every member names what the note is FOR, because a memory a parent cannot see the use
 * of is a memory they are right to resent, and every member names the way out again,
 * since this is the second-most-read message in the lane.
 *
 * NOT ONE OF THEM ASKS ANYTHING, and that is the one place this pool departs from the ask
 * pools' "exactly one question" rule rather than obeying it. An ack is Hale's last word
 * after a parent's diary line: a question here would be a second ask on a lane whose
 * keywords a bare answer already claims (rule 11), which is the exact failure the rule
 * exists to prevent.
 *
 * IT IS POOLED IN BOTH LANGUAGES ON PURPOSE. This is the one bilingual surface in the
 * voice work, and an English-only pool would widen the FR gap five sentences at a stroke.
 * A reply HAS a language in front of it, which is why this half can be bilingual while
 * the evening ask cannot (see the file header).
 *
 * "Noted - thanks" is gone: *noted* as a bare opener is on rule 3's banned list, and this
 * lane was the only place still using it.
 */
export const CHECK_IN_NOTED_ACK_POOL: Record<ReplyLanguage, readonly string[]> = {
  en: [
    "Thanks - that helps. I'll keep it in mind for the weekend picks. Reply NO to drop these.",
    'Got it, thanks. That goes into what I look for on the weekend. Reply NO to drop these.',
    'Thanks for telling me. It shapes what I put in front of you next. Reply NO to drop these.',
    "Kept, thanks. I'll remember it when I'm picking weekend things. Reply NO to drop these.",
    "Thanks - I'll bear that in mind next time I go looking. Reply NO to drop these.",
  ],
  fr: [
    "Merci - c'est utile. J'y penserai pour les suggestions du week-end. Répondez NO pour ne plus en recevoir.",
    'Entendu, merci. Cela compte dans ce que je cherche pour le week-end. Répondez NO pour ne plus en recevoir.',
    'Merci de me le dire. Cela oriente ce que je vous proposerai ensuite. Répondez NO pour ne plus en recevoir.',
    "Gardé, merci. Je m'en souviendrai en choisissant vos sorties. Répondez NO pour ne plus en recevoir.",
    "Merci - j'y penserai la prochaine fois que je cherche. Répondez NO pour ne plus en recevoir.",
  ],
};
for (const [language, pool] of Object.entries(CHECK_IN_NOTED_ACK_POOL)) {
  assertPoolSize(pool, `${NOTED_ACK_POOL_NAME}:${language}`);
}

/** Tonight's thank-you, in the language the parent just wrote in. */
export function checkInNotedAck(
  language: ReplyLanguage,
  familyId: string,
  occasion: number,
): string {
  return pickVariant(CHECK_IN_NOTED_ACK_POOL[language], NOTED_ACK_POOL_NAME, familyId, occasion);
}

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
