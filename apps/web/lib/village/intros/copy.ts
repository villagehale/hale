import type { FamilyStage } from '@hale/types';

/**
 * Village intros v1 — every FIXED word Hale says about an introduction.
 *
 * THE TWO ASKS LEFT THIS FILE ON 2026-08-13 (see voice.ts). They were the last two
 * strings on this surface that handed a parent a keyword to recite, and reading them back
 * to back — "Reply YES INTROS or NO INTROS." then, hours later, "Reply YES INTRO or NO
 * INTRO." — is what made the founder call the whole feature inhuman. They are composed
 * now, under pinned meanings and mechanical refusals, and the parent's answer is read
 * however they phrase it.
 *
 * WHAT STAYED IS EVERY ACKNOWLEDGEMENT, and the original argument still holds for them:
 * an intro is a cross-household DISCLOSURE, and the sentences that CONFIRM one — the
 * soft close in particular, which must read identically whether the other side said no,
 * said nothing, or ran out of time — are exactly the sentences a model must not vary.
 * A fixed line needs only a test that reads it, and that test can be exhaustive.
 *
 * THE PRIVACY RULE IS STRUCTURAL WHEREVER THE WORDS COME FROM. It never lived in this
 * file's fixedness; it lives in what the renderers are HANDED. The composed card's
 * request type carries the same three facts `coarseCard` took — a stage WORD (a band, not
 * a child), the recipient's OWN child through the teen gate, and a civic activity title —
 * and there is no parameter on either side that could name the other household.
 *
 * GSM-7 throughout (plain hyphens, straight apostrophes, no emoji), enforced by
 * lib/channel/sms-copy-encoding.test.ts, which reads this file off disk.
 */

/**
 * How Hale refers to a child of a given stage when it is talking about SOMEBODY ELSE'S
 * child — the one and only counterpart fact a coarse card carries.
 *
 * These are nouns, deliberately, and different from the dashboard's `STAGE_LABEL`
 * adjectives: "a Hale family near you has a preschool" is not English, and a card a
 * parent has to re-read is a card that reads as spam. `Record<FamilyStage, string>` so
 * a new stage cannot ship without someone choosing its word.
 *
 * 'teenager' has a word here even though v1 never matches on the teen band (see
 * `eligibleAnchorChildren`): the map must stay total, and the day teen intros earn a
 * consent model of their own, the word should not be invented in a hurry.
 */
const STAGE_WORD: Record<FamilyStage, string> = {
  newborn: 'baby',
  toddler: 'toddler',
  preschool: 'preschooler',
  child: 'kid',
  teenager: 'teen',
};

export function stageWord(stage: FamilyStage): string {
  return STAGE_WORD[stage];
}

/**
 * THE DISCOVERABILITY ASK AND THE COARSE CARD ARE COMPOSED (voice.ts).
 *
 * Consent first, matching second, unchanged: Hale asks whether a family wants to be
 * findable BEFORE it has looked for anyone, so a "no" costs them nothing and reveals
 * nothing. What changed is the words. The two fixed sentences that used to live here both
 * ended in a magic word — and the answer no longer needs one, because a reply to either
 * question is read by the resolver in lib/channel/router/resolve.ts however the parent
 * chose to phrase it. The keyword READS still work; nothing prints them any more.
 */

/** What a family hears when they opt in. Says what happens next and what does not:
 * nothing is shared yet, and nothing will be without a second yes.
 *
 * The off-ramp is named without naming a keyword. "Just tell me" is true — a parent who
 * says "actually, no intros" or "turn that off" is read by the resolver — and it is the
 * difference between an operator and an unsubscribe footer. */
export const DISCOVERABILITY_ON =
  "Great - I'll keep an eye out. Nothing is shared until you both say yes, and you can tell me to stop anytime.";

/** What a family hears when they opt out, or later revoke. No persuasion, no "are you
 * sure": a revocation that gets argued with is not a revocation. */
export const DISCOVERABILITY_OFF = "Done - no intros. I won't bring this up again.";

/**
 * THE SECOND YES, AND THE SECOND NO.
 *
 * From the founder's live test (2026-08-13, 09:47:48 -> 09:47:59): the parent texted
 * "Yes", got no traction, and eleven seconds later retyped "Yes intros". A parent who
 * texts twice because they think the first one did not land is not making a second
 * decision, and answering them with the full acknowledgement a second time is Hale failing
 * to remember a conversation it is currently having.
 *
 * SHORT, and it still ANSWERS. Silence would read as the second text not landing either,
 * which is the very thing that produced the second text. What it does not do is re-explain
 * a thing they have already been told, or imply anything changed.
 */
export const DISCOVERABILITY_ALREADY_ON = "You're already set - I'll keep an eye out.";

export const DISCOVERABILITY_ALREADY_OFF = "Already off - I won't bring it up.";

/** Acknowledges a yes to one intro. Deliberately says nothing about the other side:
 * at this moment their answer is unknown, and even "waiting on them" would disclose
 * that a specific household was asked. */
export const INTRO_YES_ACK = "Great - if they're in too, I'll introduce you both by email.";

/** Acknowledges a no to one intro. */
export const INTRO_NO_ACK = "No problem - I'll keep looking.";

/**
 * What an intro keyword gets when there is no card waiting for it.
 *
 * This lane CLAIMS the message anyway, which is the opposite of how the approval
 * grammar treats a bare "yes". The reason is that INTRO is not an ambiguous word: a
 * parent who texts it is unmistakably talking about intros, so handing the turn to the
 * coach would spend a model call to guess at something already known. What it must not
 * do is imply a match exists.
 */
export const NO_OPEN_INTRO = "I don't have an intro waiting for you right now - I'll text you when there's a match.";

/**
 * THE SOFT CLOSE — what the other side hears when an intro does not happen.
 *
 * ONE sentence for THREE different causes: they said no, they never answered, or the
 * seven days ran out. That is the whole design. A parent who said yes and hears "they
 * passed" has learned something about a household that never agreed to tell them
 * anything, and a parent who hears "they never replied" has learned it too. The
 * message is identical in all three cases so the recipient cannot infer which one
 * happened, and the test that pins it asserts exactly that.
 */
export const INTRO_SOFT_CLOSE = "No intro this time - I'll keep an eye out.";

/** The subject line of the one email that carries an actual introduction. */
export const INTRO_EMAIL_SUBJECT = 'A Hale family near you';

/**
 * THE INTRO EMAIL — the only place two households ever see each other.
 *
 * First names only, on both sides. What it discloses is exactly what both parents said
 * yes to twice: their own first name, their email address (by being on the To/Cc line),
 * the stage band they share, and the activity if there is one. No last names, no
 * numbers, no neighbourhood, no children's names.
 *
 * The last line matters as much as the first. Hale made the introduction and Hale is
 * now out of it: an operator that lingers in a conversation between two parents is
 * reading a conversation it has no business in, and saying so plainly is the only way a
 * parent can tell the difference.
 */
export function introEmailBody(input: {
  parentAFirstName: string;
  parentBFirstName: string;
  stage: FamilyStage;
  anchorTitle: string | null;
}): string {
  const both = `${input.parentAFirstName} and ${input.parentBFirstName}`;
  const lines = [
    `Hi ${both},`,
    '',
    `You're both Hale families in the same neighbourhood, you each have a ${stageWord(input.stage)}, and you both said yes to an introduction. So: meet each other.`,
  ];
  if (input.anchorTitle !== null) {
    lines.push('', `You were also both eyeing ${input.anchorTitle} - that might be the easy first hello.`);
  }
  lines.push(
    '',
    "That's all from me. Just hit reply-all and take it from here - I'm stepping back.",
    '',
    'Hale',
  );
  return lines.join('\n');
}
