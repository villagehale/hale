import type { WeekdayCare } from '~/lib/care/weekday';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { segmentsOf, words } from '~/lib/channel/stated-state';

/**
 * WHAT A PARENT SAID ABOUT THEIR WEEKDAYS — read deterministically.
 *
 * Deterministic for the two reasons its sibling `stated-state.ts` gives: it runs on the
 * turn a parent is waiting on, so a model call here buys latency on every inbound text;
 * and the row it produces changes what Hale offers a household for MONTHS, so the
 * reader that decides has to be one a corpus can pin exactly.
 *
 * WHY IT IS A SIBLING OF `recordStatedState` RATHER THAN A MEMBER OF IT. Three
 * differences, and any one of them would be a stretch: the answer is THREE-WAY where
 * `StatedState` is a set of binary settlements; the CHILD comes from the ask's dedupe
 * key rather than from the words, so this reader needs an input that one does not take;
 * and the write lands in a different table behind a different writer pin. It shares the
 * one thing that must not fork - `segmentsOf`, imported rather than copied, because a
 * second private normaliser is how two readers start disagreeing about what "it's" is.
 *
 * IT FAILS CLOSED. A message that engages the question but settles nothing reads as
 * `nothing_stated`, and the caller - which is the only thing that knows whether the ask
 * is standing - names that turn `unreadable` and logs it. The cost of a wrong read is a
 * durable fact; the cost of a missed one is that the coach answers in prose, which is
 * what it was going to do anyway.
 */

export type WeekdayCareReading =
  | { status: 'read'; care: WeekdayCare; provider: string | null }
  /** The ordinary answer on nearly every message, and on a bare "yes" or "no": the
   * question is an either/or, so a bare polarity is meaningless rather than dangerously
   * plausible. */
  | { status: 'nothing_stated' };

/** The words that make a message ABOUT organised childcare. `segmentsOf` closes up
 * apostrophes and sweeps punctuation to spaces, so "day-care" arrives as "day care".
 * Written once as an alternation because the negation rule below has to name the same
 * set — two lists would drift, and the drift would be invisible. */
const CARE_WORDS =
  'daycare|day care|childcare|child care|preschool|pre school|nursery|creche|montessori|after school';

const CARE_WORD = new RegExp(`\\b(?:${CARE_WORDS})\\b`);

/**
 * It has not started yet, and this is tested BEFORE the negation rule on purpose.
 *
 * "no daycare yet" and "not in daycare yet, starts Sept" both contain a negated care
 * word, and reading either as `home` would file the wrong DURABLE fact for a family six
 * weeks from a start date. Under R9 the two readings differ only in what the follow-up
 * does, which makes the misread quieter and worse.
 */
const STARTS_SOON = /\b(?:starts|starting)\b|\bnot yet\b|\bwait list\b|\bwaitlist\b|\bon a list\b/;

/**
 * Bare "start" is only a care word next to one. A parent answering the either/or names
 * the rest of their week in the same breath — "we start swimming Saturday" — and
 * reading that as a start DATE files `starting_soon` for a household that just said it
 * is home. `starts` and `starting` are the inflections a start date arrives in; the
 * bare stem is the one that collides with every other activity a family does.
 */
const BARE_START = /\bstart\b/;

/** Never a bare "looking": "looking for a swim class" is not a childcare answer. */
const LOOKING_FOR_CARE =
  /\blooking (?:for|at|into) (?:daycare|day care|childcare|child care|a spot|a place)\b/;

/** `yet` only counts as "not started" when the sentence is about care at all. */
const YET = /\byet\b/;

/**
 * A NEGATION THAT GOVERNS THE CARE WORD — not one that merely shares a sentence with it.
 *
 * The ask is an either/or, so the replies that mean `daycare` are full of negatives:
 * the parent refuses the first half of the question and then names the second. "no,
 * daycare", "daycare, not home", "at daycare not with me" and "she's in daycare, no
 * complaints" all carry a negative and all mean daycare, and a rule that asked only
 * whether both appear ANYWHERE in the segment filed `home` for every one of them — the
 * wrong DURABLE fact, which switches the weekday find off and stops the daycare
 * follow-up ever firing for a household that said daycare.
 *
 * So the negation has to REACH the care word, across determiners and the prepositions
 * that carry an arrangement and nothing else. "no daycare" and "we don't do daycare"
 * reach it; "no she's at daycare" does not, because a pronoun is not in the window.
 *
 * `nope` and `nah` are deliberately absent, and their absence is the rule rather than
 * an oversight: they are answer particles and cannot modify a noun at all, so "nope
 * daycare" can only be the answer "nope" followed by the answer, where "no daycare" is
 * a grammatical negated noun phrase. That distinction is the whole difference between
 * the two, and it is decidable from the words.
 */
const NEGATION = 'no|not|never|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt';

/** What a negation may cross to reach its care word: determiners and the prepositions
 * and light verbs that carry an arrangement. A pronoun is deliberately not here. */
const REACHES = 'in|at|the|a|an|any|to|go|goes|going|do|doing|does|did|using|use';

const NEGATED_CARE = new RegExp(
  `\\b(?:${NEGATION})\\b(?:\\s+(?:${REACHES})\\b)*\\s+(?:${CARE_WORDS})\\b`,
);

/**
 * A comma is the only evidence a text message gives that "no" was an ANSWER rather than
 * a determiner: "no daycare" negates the noun, "no, daycare" answers the first half of
 * the either/or and then names the second. So the governing test runs per CLAUSE, and a
 * clause boundary is exactly what a negation may not reach across.
 */
interface Clause {
  /** Still in its own case, because the provider is read off the original. */
  raw: string;
  words: string;
}

function clausesOf(sentence: string): Clause[] {
  return sentence
    .split(/[,;]/)
    .map((raw) => ({ raw, words: words(raw) }))
    .filter((clause) => clause.words.length > 0);
}

/** A parent, a grandparent, a nanny — all the same to the finder, because the axis is
 * whether a weekday-morning drop-in is useful to this household. Written once as an
 * alternation for the reason {@link CARE_WORDS} is: the negation rule below names the
 * same set, and two lists would drift invisibly. */
const HOME_WORDS =
  'home|with me|with us|stay at home|sahm|(?:with )?(?:my|his|her|our) (?:mom|mum|mother|dad|father|grandma|grandmother|grandpa|grandfather|nana|nanny|sitter|babysitter|aunt|uncle)';

const HOME = new RegExp(`\\b(?:${HOME_WORDS})\\b`);

/**
 * A NEGATION THAT GOVERNS THE HOME PHRASE — the symmetric half of {@link NEGATED_CARE},
 * and its absence was a live defect.
 *
 * The ask offers "home with you" as one SIDE of an either/or, so the ordinary way to
 * refuse that side is to negate it: "not home", "she's not with me", "he's not with us
 * during the week". Every one of those reads as the word `home` and, without this rule,
 * filed the OPPOSITE of what the parent said — a durable fact that switches the weekday
 * find on for a household at daycare and stops the daycare follow-up ever firing.
 *
 * It settles NOTHING rather than flipping to `daycare`: "not home" leaves the other side
 * unsaid (a grandparent's, a nanny's, a half-week), and guessing it is the same defect
 * one turn later. The turn reads `unreadable`, the coach answers in its own voice, and
 * nothing durable is written. Same reach, same clause rule, same list as the care half.
 */
const NEGATED_HOME = new RegExp(
  `\\b(?:${NEGATION})\\b(?:\\s+(?:${REACHES})\\b)*\\s+(?:${HOME_WORDS})\\b`,
);

/**
 * SOMEBODY ELSE'S CHILD. Deliberately narrower than `stated-state.ts`'s list: the
 * relations that appear in a HOME answer (mom, dad, grandma, nanny) are exactly the
 * ones that must not be here, because "my mom has him three days" is this household's
 * own arrangement. What is left is the relations with children of their own.
 *
 * THE PLURALS ARE LOAD-BEARING, for the reason `stated-state`'s own visit words state:
 * `words` closes up apostrophes, so the possessive that introduces most of these — "my
 * sister's kid goes to Little Sprouts" — reaches this pattern as "sisters".
 */
const OTHER_HOUSEHOLD =
  /\b(?:(?:sister|brother|cousin|friend|neighbour|neighbor|coworker|colleague)s?|someone else|somebody else)\b/;

/** Hale's own words handed back, or a third party's. */
const REPORTED = /\b(?:you said|said|says|saying|told|heard|apparently|supposedly)\b/;

/** The parent is asking Hale to act, which is the opposite of stating a fact. */
const INSTRUCTION =
  /^(?:please |just |ok |okay )*(?:add|put|book|schedule|find|send|make|set|remind|call|can|could|would|will|do|lets|let us)\b/;

const COUNTERFACTUAL =
  /\b(?:would|wouldve|could|couldve|might|mightve|shouldve|wish|wished|hoping|hoped|almost|nearly|supposed to|meant to|if)\b/;

const BLOCKERS = [OTHER_HOUSEHOLD, REPORTED, INSTRUCTION, COUNTERFACTUAL] as const;

/**
 * The provider, read from ONE SENTENCE in its original case, and only when the parent
 * named one in so many words.
 *
 * A capitalised proper noun of one to four words, adjacent to `at` / `goes to` /
 * `attends`, and nothing else. A parent who types all lowercase loses the name; that
 * costs one missing subject, and the alternative is Hale inventing a business name.
 *
 * ONE SENTENCE, never the whole body: reading the name off the body while the care word
 * was read off a sentence let a REFUSED sentence hand its daycare to the sentence that
 * answered the question ("My sister put hers in daycare at Little Sprouts. Mine is home
 * with me.").
 *
 * IT IS NOT NECESSARILY A BUSINESS. "at Nana's" and "goes to Sarah's daycare" both pass,
 * so the string may be a person's name — which is why it lives in exactly one
 * family-scoped row, never in `audit_log` (a boolean goes there), never in a log line,
 * and never across a family boundary.
 */
/** A capitalised word in ANY alphabet, because "Château Enfants" and "École Polly" are
 * ordinary Ontario daycare names and an ASCII-only capture read them as no answer at
 * all — throwing away the parent's reply rather than just its pin. What a phone cannot
 * print is decided below, on the captured string, not by refusing to see it. */
const PROVIDER_WORD = String.raw`\p{Lu}[\p{L}\p{N}_'\u2018\u2019-]*`;

/**
 * Each captured word ends at whitespace, at terminal punctuation, or at the end of the
 * message. Requiring WHITESPACE alone dropped the last word of every name a parent
 * punctuated — "She goes to Little Sprouts." captured "Little" — and that truncation is
 * durable twice over: it is persisted in the fact, and then pinned verbatim into the
 * follow-up's voice, which is asked to name a place that does not exist.
 */
const PROVIDER_TAIL = String.raw`(?:\s+|(?=[.,!?;:)\]"]|$))`;

/** `goes to` / `attends` NAME A DESTINATION, so they carry the daycare reading on their
 * own. A bare `at` does not — see {@link readWeekdayCare}'s order. */
const NAMED_DESTINATION = new RegExp(
  `\\b(?:goes to|attends)\\s+((?:${PROVIDER_WORD}${PROVIDER_TAIL}){1,4})`,
  'u',
);

const NAMED_AT = new RegExp(`\\bat\\s+((?:${PROVIDER_WORD}${PROVIDER_TAIL}){1,4})`, 'u');

/**
 * What an `at` / `goes to` phrase named, and whether it named anything at all.
 *
 * The two are DIFFERENT and rule #11 does not let them share a value: a name Hale
 * cannot print is still a parent saying their child goes somewhere, so the care reads
 * and only the pin is dropped.
 */
interface ProviderCapture {
  named: boolean;
  provider: string | null;
}

const NOTHING_NAMED: ProviderCapture = { named: false, provider: null };

/**
 * A curly apostrophe is what an iPhone types, and U+2019 is not in the GSM-7 basic
 * alphabet. Persisting one would hand the follow-up voice a subject it can only refuse
 * — `not_gsm7` if it echoes the character, `subject_missing` if it straightens it —
 * three compose calls a tick until the window passes. Decided here instead, where the
 * string is still a candidate: straighten what can be straightened, and drop the PIN
 * (the follow-up then asks generically) for anything a phone still cannot print.
 */
function captureProvider(sentence: string, pattern: RegExp): ProviderCapture {
  const captured = pattern.exec(sentence)?.[1]?.trim();
  if (captured === undefined || captured.length === 0) return NOTHING_NAMED;
  const straightened = captured.replace(/[\u2018\u2019\u02bc]/g, "'");
  return { named: true, provider: isPrintableGsm7Basic(straightened) ? straightened : null };
}

/**
 * "we're" normalises to "were", which the shared question heuristic reads as the
 * auxiliary that opens "were you there?" — so "we're looking for daycare" was being
 * refused as a question.
 *
 * Fixed HERE rather than in `words`, and only for `'re`. That heuristic is right where
 * it lives: `stated-state` runs on every inbound message with no question standing, so
 * an unmarked question has to be refused, and its false positives cost one repeated
 * nudge. This reader runs on a turn where Hale has just asked an either/or, where a
 * false negative throws away the parent's answer to it — and "we're ..." is how half of
 * those answers start. Expanding the contraction keeps both readers on one normaliser
 * and removes exactly the collision, rather than weakening the heuristic for everybody.
 */
function expandAreContraction(body: string): string {
  return body.replace(/(\w)['\u2019]re\b/gi, '$1 are');
}

/**
 * The message, cut into sentences that are still in their own case.
 *
 * `segmentsOf` is the shared normaliser and stays the only one — it is handed each
 * sentence in turn rather than the whole body — but the provider is read from the
 * ORIGINAL case, so the reader needs both halves of the same sentence side by side. It
 * used to read the provider off the whole body while reading the care word off one
 * sentence, and a refused sentence then handed its daycare to the sentence that
 * answered the question: "My sister put hers in daycare at Little Sprouts. Mine is home
 * with me." filed daycare at a place the parent's child has never been.
 */
function sentencesOf(body: string): { raw: string; words: string; question: boolean }[] {
  return (body.match(/[^.!?\n]+[.!?\n]*/g) ?? []).flatMap((raw) => {
    const segment = segmentsOf(raw)[0];
    return segment === undefined ? [] : [{ raw, ...segment }];
  });
}

/**
 * THE ORDER IS THE SPEC: `starting_soon`, then the negated care word, then the care
 * word, then a named destination, then the NEGATED home phrase (which settles nothing
 * and refuses the sentence), then the home phrases, and a bare "at <Name>" LAST.
 * Reversing the first two is the misread this grammar was rewritten to prevent; putting
 * the bare `at` capture before the home phrases is the one that reads "home with me, I
 * work at Shopify" as daycare.
 */
export function readWeekdayCare(body: string): WeekdayCareReading {
  for (const sentence of sentencesOf(expandAreContraction(body))) {
    if (sentence.question) continue;
    const text = sentence.words;
    if (BLOCKERS.some((blocker) => blocker.test(text))) continue;

    const clauses = clausesOf(sentence.raw);
    if (
      STARTS_SOON.test(text) ||
      LOOKING_FOR_CARE.test(text) ||
      (CARE_WORD.test(text) && (YET.test(text) || BARE_START.test(text)))
    ) {
      return { status: 'read', care: 'starting_soon', provider: null };
    }
    if (clauses.some((clause) => NEGATED_CARE.test(clause.words))) {
      return { status: 'read', care: 'home', provider: null };
    }

    // THE NAME BELONGS TO THE CLAUSE THAT NAMED THE CARE, and nowhere else. "I work at
    // Shopify, she is at daycare" carries both a care word and a capitalised `at`
    // phrase, and reading the name off the whole sentence pinned the PARENT'S EMPLOYER
    // to the child — persisted in the fact, then handed verbatim to the follow-up voice.
    // A care clause that names nobody names NOBODY: the follow-up already knows how to
    // ask generically, and a wrong name is the one thing it cannot recover from.
    const carer = clauses.find(
      (clause) => CARE_WORD.test(clause.words) || NAMED_DESTINATION.test(clause.raw),
    );
    if (carer) {
      const destination = captureProvider(carer.raw, NAMED_DESTINATION);
      const capture = destination.named ? destination : captureProvider(carer.raw, NAMED_AT);
      return { status: 'read', care: 'daycare', provider: capture.provider };
    }
    if (clauses.some((clause) => NEGATED_HOME.test(clause.words))) continue;
    if (HOME.test(text)) {
      return { status: 'read', care: 'home', provider: null };
    }
    const somewhere = clauses.find((clause) => NAMED_AT.test(clause.raw));
    if (somewhere) {
      const capture = captureProvider(somewhere.raw, NAMED_AT);
      if (capture.named) return { status: 'read', care: 'daycare', provider: capture.provider };
    }
  }
  return { status: 'nothing_stated' };
}
