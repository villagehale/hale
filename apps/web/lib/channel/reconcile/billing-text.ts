import type { ReplyLanguage } from '~/lib/channel/language';
import { claimReadLocale } from './sentences';

export type BillingPlanName = 'Free' | 'Plus' | 'Max';

/** VIL-735 · what a billing notice's writer was told, in the shape the send gate reads. */
export interface BillingClaimFacts {
  language: ReplyLanguage | null;
  plan: BillingPlanName;
  previousPlan: BillingPlanName | null;
  ended: boolean;
  refunds: readonly { refundedMinor: number; chargeMinor: number }[];
  paidThrough: { date: string; year: number; month: number; day: number } | null;
}

/** The Free plan's name in the site's languages (apps/site/messages). Everyday words,
 * which is why a text naming Free is the fact check's call and not {@link billingTextConflict}'s. */
const FREE_PLAN_WORDS: ReadonlySet<string> = new Set(['free', '免费']);
const FREE_PLAN_FRENCH_STEM = 'gratuit';

/** Money as the product writes it: a plain `$`, no currency note (billing/price-display.ts). */
export function billingDollars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

function wordsOf(sentence: string, locale: string | undefined): string[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
  return [...segmenter.segment(sentence)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

function sentencesOf(text: string, locale: string | undefined): string[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  return [...segmenter.segment(text)].map((segment) => segment.segment);
}

function planConflict(text: string, facts: BillingClaimFacts, locale: string | undefined): boolean {
  const held = new Set<string>([facts.plan, ...(facts.previousPlan ? [facts.previousPlan] : [])]);
  for (const sentence of sentencesOf(text, locale)) {
    const words = wordsOf(sentence, locale);
    for (const [index, word] of words.entries()) {
      if (word !== 'Plus' && word !== 'Max') continue;
      // "Plus, your plans stay." and "Plus de frais." are ordinary words.
      if (word === 'Plus' && index === 0) continue;
      if (!held.has(word)) return true;
    }
  }
  return false;
}

/** One digit at a time: normalizing the whole string turns a full-width comma into `,`,
 * and `159.00，2027` then reads as one number. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => digit.normalize('NFKC'));
}

const NUMBER_RUN = /\d+(?:[.,  ]\d+)*/g;
const RUN_SEPARATOR = /[.,  ]/;

/**
 * A run in minor units. A separator is a decimal point only when exactly two digits end
 * the run; the rest group thousands. A run that fits neither is separate numbers.
 */
function runValues(run: string): number[] {
  const groups = run.split(RUN_SEPARATOR);
  const separators = [...run].filter((ch) => RUN_SEPARATOR.test(ch));
  const whole = (parts: readonly string[]) => Number(parts.join(''));
  if (separators.length === 0) return [whole(groups) * 100];

  const last = groups[groups.length - 1] as string;
  const lastSeparator = separators[separators.length - 1] as string;
  const decimal = last.length === 2 && (lastSeparator === '.' || lastSeparator === ',');
  const integerGroups = decimal ? groups.slice(0, -1) : groups;
  const groupSeparators = decimal ? separators.slice(0, -1) : separators;
  const grouped =
    groupSeparators.length === 0 ||
    ((integerGroups[0] as string).length <= 3 &&
      integerGroups.slice(1).every((group) => group.length === 3) &&
      new Set(groupSeparators).size === 1 &&
      !(decimal && groupSeparators[0] === lastSeparator));
  if (!grouped) return groups.map((group) => Number(group) * 100);
  return [whole(integerGroups) * 100 + (decimal ? Number(last) : 0)];
}

function numberConflict(text: string, facts: BillingClaimFacts): boolean {
  const ascii = asciiDigits(text);
  // A digit NFKC cannot map is one this floor cannot read, so it cannot vouch for it.
  if (/\p{Nd}/u.test(ascii.replace(/[0-9]/g, ''))) return true;
  const allowed = new Set<number>();
  for (const refund of facts.refunds) {
    allowed.add(refund.refundedMinor);
    allowed.add(refund.chargeMinor);
  }
  if (facts.paidThrough) {
    allowed.add(facts.paidThrough.year * 100);
    allowed.add(facts.paidThrough.month * 100);
    allowed.add(facts.paidThrough.day * 100);
  }
  for (const [run] of ascii.matchAll(NUMBER_RUN)) {
    if (runValues(run).some((value) => !allowed.has(value))) return true;
  }
  return false;
}

/**
 * The whole-text floor for a billing notice, run whatever the claim reader did. A plan
 * name or a number the facts do not hold is a conflict. It reads Hale's own sentence and
 * can only refuse; what a token cannot judge ("still on Plus" after a cancel) is the fact
 * check's job.
 */
export function billingTextConflict(
  text: string,
  facts: BillingClaimFacts,
): 'plan' | 'number' | null {
  if (planConflict(text, facts, claimReadLocale(facts.language))) return 'plan';
  if (numberConflict(text, facts)) return 'number';
  return null;
}

/**
 * Whether a sentence names the plan the family is on now. The plan row in the claim gate
 * looks like a confirmed registration to the reader, so it backs a sentence only when
 * that sentence is about the plan.
 */
export function namesCurrentPlan(
  sentence: string,
  plan: BillingPlanName,
  locale: string | undefined,
): boolean {
  const words = wordsOf(sentence, locale);
  if (plan === 'Free') {
    return words.some((word) => {
      const lower = word.toLocaleLowerCase();
      return FREE_PLAN_WORDS.has(lower) || lower.startsWith(FREE_PLAN_FRENCH_STEM);
    });
  }
  return words.some((word, index) => word === plan && !(plan === 'Plus' && index === 0));
}
