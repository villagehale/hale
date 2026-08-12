import type { FamilyStage } from '@hale/types';

/**
 * Village intros v1 — every word Hale says about an introduction.
 *
 * This file is the SPEC, not a template layer. There is no model anywhere in this
 * feature and that is the point: an intro is a cross-household DISCLOSURE, and the one
 * thing a disclosure must never be is improvised. A composed sentence would need an
 * eval to prove it never names the other family; a fixed sentence needs only a test
 * that reads it, and the test can be exhaustive.
 *
 * THE PRIVACY RULE IS STRUCTURAL, not editorial. {@link coarseCard} takes no argument
 * that could carry the other family's identity — not a name, not an age, not an area.
 * The only counterpart fact it is given is a stage WORD, and a stage word is a fact
 * about a band, not about a child. A future edit cannot leak what was never passed in.
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
 * THE DISCOVERABILITY ASK — the first and only time Hale raises intros unprompted.
 *
 * Consent first, matching second. Hale asks whether a family wants to be findable
 * BEFORE it has looked for anyone, so a "no" costs the family nothing and reveals
 * nothing: at the moment this text is sent, Hale knows only that the family shares an
 * FSA with at least one other household, which is a fact about the postal system.
 *
 * The keywords are two words rather than a bare YES because this question can arrive
 * while other things are pending. A bare "yes" belongs to whatever Hale last asked;
 * INTROS says which question is being answered, and the router's approval grammar
 * declines it precisely because it is not a bare affirmative.
 */
export const DISCOVERABILITY_ASK =
  "Something new: other Hale families are near you. Want me to introduce you when there's a great match? Reply YES INTROS or NO INTROS.";

/** What a family hears when they opt in. Says what happens next and what does not:
 * nothing is shared yet, and nothing will be without a second yes. */
export const DISCOVERABILITY_ON =
  "Great - I'll keep an eye out. Nothing is shared until you both say yes. Reply NO INTROS anytime to switch this off.";

/** What a family hears when they opt out, or later revoke. No persuasion, no "are you
 * sure": a revocation that gets argued with is not a revocation. */
export const DISCOVERABILITY_OFF = "Done - no intros. I won't bring this up again.";

/**
 * THE COARSE CARD — the symmetric ask both sides get at the same time.
 *
 * `ownChildPossessive` is the recipient's OWN child, already rendered through
 * `loopChildName` (so a 13+ child reads as "your kid" and a parent's child_name_level
 * dial is honoured), with an apostrophe-s applied. `counterpartStage` is a band word.
 * There is no third fact, and no parameter this function could be handed that would
 * name the other household.
 *
 * "around X's age" rather than the spec's bare "around X's": the possessive needs its
 * noun to be a sentence, and every rendering — "around Maya's age", "around your
 * son's age", "around your kid's age" — reads the same way.
 */
export function coarseCard(
  counterpartStage: FamilyStage,
  ownChildPossessive: string,
  anchor: string | null,
): string {
  const opening = `A Hale family near you has a ${stageWord(counterpartStage)} around ${ownChildPossessive} age.`;
  const question = 'Want an intro? Reply YES INTRO or NO INTRO.';
  return anchor === null ? `${opening} ${question}` : `${opening} ${anchor} ${question}`;
}

/**
 * The activity anchor — Hale's upgrade over a bare "someone near you".
 *
 * A purposeful intro is safer than a social one: two parents who are both going to the
 * same free storytime on Saturday have a reason to meet that neither of them had to
 * invent. `title` is passed through VERBATIM from the civic_sessions row, never
 * paraphrased — the dataset is the only thing that knows what the session is called,
 * and a reworded title is a fact Hale made up.
 */
export function activityAnchor(title: string, day: string): string {
  return `They're also eyeing ${title} ${day}.`;
}

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
