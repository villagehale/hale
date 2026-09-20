import type { WeekdayCare } from '~/lib/care/weekday';
import { segmentsOf } from '~/lib/channel/stated-state';

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
 * apostrophes and sweeps punctuation to spaces, so "day-care" arrives as "day care". */
const CARE_WORD =
  /\b(?:daycare|day care|childcare|child care|nursery|creche|montessori|after school)\b/;

/**
 * It has not started yet, and this is tested BEFORE the negation rule on purpose.
 *
 * "no daycare yet" and "not in daycare yet, starts Sept" both contain a negated care
 * word, and reading either as `home` would file the wrong DURABLE fact for a family six
 * weeks from a start date. Under R9 the two readings differ only in what the follow-up
 * does, which makes the misread quieter and worse.
 */
const STARTS_SOON = /\b(?:starts|starting|start)\b|\bnot yet\b|\bwait list\b|\bwaitlist\b|\bon a list\b/;

/** Never a bare "looking": "looking for a swim class" is not a childcare answer. */
const LOOKING_FOR_CARE =
  /\blooking (?:for|at|into) (?:daycare|day care|childcare|child care|a spot|a place)\b/;

/** `yet` only counts as "not started" when the sentence is about care at all. */
const YET = /\byet\b/;

const NEGATED =
  /\b(?:no|not|nope|nah|never|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt)\b/;

/** A parent, a grandparent, a nanny — all the same to the finder, because the axis is
 * whether a weekday-morning drop-in is useful to this household. */
const HOME =
  /\b(?:home|with me|with us|stay at home|sahm)\b|\b(?:my|his|her|our) (?:mom|mum|mother|dad|father|grandma|grandmother|grandpa|grandfather|nana|nanny|sitter|babysitter|aunt|uncle)\b/;

/**
 * SOMEBODY ELSE'S CHILD. Deliberately narrower than `stated-state.ts`'s list: the
 * relations that appear in a HOME answer (mom, dad, grandma, nanny) are exactly the
 * ones that must not be here, because "my mom has him three days" is this household's
 * own arrangement. What is left is the relations with children of their own.
 */
const OTHER_HOUSEHOLD =
  /\b(?:sister|brother|cousin|friend|friends|neighbour|neighbours|neighbor|neighbors|coworker|colleague|someone else|somebody else)\b/;

/** Hale's own words handed back, or a third party's. */
const REPORTED = /\b(?:you said|said|says|saying|told|heard|apparently|supposedly)\b/;

/** The parent is asking Hale to act, which is the opposite of stating a fact. */
const INSTRUCTION =
  /^(?:please |just |ok |okay )*(?:add|put|book|schedule|find|send|make|set|remind|call|can|could|would|will|do|lets|let us)\b/;

const COUNTERFACTUAL =
  /\b(?:would|wouldve|could|couldve|might|mightve|shouldve|wish|wished|hoping|hoped|almost|nearly|supposed to|meant to|if)\b/;

const BLOCKERS = [OTHER_HOUSEHOLD, REPORTED, INSTRUCTION, COUNTERFACTUAL] as const;

/**
 * The provider, read from the ORIGINAL-CASE body and only when the parent named one in
 * so many words.
 *
 * A capitalised proper noun of one to four words, adjacent to `at` / `goes to` /
 * `attends`, and nothing else. A parent who types all lowercase loses the name; that
 * costs one missing subject, and the alternative is Hale inventing a business name.
 *
 * IT IS NOT NECESSARILY A BUSINESS. "at Nana's" and "goes to Sarah's daycare" both pass,
 * so the string may be a person's name — which is why it lives in exactly one
 * family-scoped row, never in `audit_log` (a boolean goes there), never in a log line,
 * and never across a family boundary.
 */
const PROVIDER = /\b(?:at|goes to|attends)\s+((?:[A-Z][\w'’-]*(?:\s+|$)){1,4})/;

function providerIn(body: string): string | null {
  const match = PROVIDER.exec(body);
  const captured = match?.[1]?.trim();
  return captured !== undefined && captured.length > 0 ? captured : null;
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
 * THE ORDER IS THE SPEC: `starting_soon`, then the negated care word, then the care
 * word, then the home phrases. Reversing the first two is the misread this grammar was
 * rewritten to prevent.
 */
export function readWeekdayCare(body: string): WeekdayCareReading {
  for (const segment of segmentsOf(expandAreContraction(body))) {
    if (segment.question) continue;
    const text = segment.words;
    if (BLOCKERS.some((blocker) => blocker.test(text))) continue;

    const careWord = CARE_WORD.test(text);
    if (STARTS_SOON.test(text) || LOOKING_FOR_CARE.test(text) || (careWord && YET.test(text))) {
      return { status: 'read', care: 'starting_soon', provider: null };
    }
    if (careWord && NEGATED.test(text)) {
      return { status: 'read', care: 'home', provider: null };
    }
    const provider = providerIn(body);
    if (careWord || provider !== null) {
      return { status: 'read', care: 'daycare', provider };
    }
    if (HOME.test(text)) {
      return { status: 'read', care: 'home', provider: null };
    }
  }
  return { status: 'nothing_stated' };
}
