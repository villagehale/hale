/**
 * VIL-260 · WS5 — the age a civic source ACTUALLY stated, read from its own words.
 *
 * WHY THIS EXISTS. A library files every under-six program under one calendar-wide
 * audience ("Preschool Children (0-5)", "Babies, Toddlers & Preschool"), so the
 * audience registry alone cannot tell a newborn's lap-bounce apart from a
 * four-year-old's craft hour — and a 2-year-old was being offered "Babytime
 * (0–12 months)" under a "0–5 years" label. The real age is almost always written
 * down: in the title for RHPL and Markham, and in the DESCRIPTION for TPL, whose
 * Baby Time says "birth to 18 months" nowhere else. Reading it is what makes the
 * band the source's claim instead of the taxonomy's.
 *
 * WHY IT IS SO SUSPICIOUS. These descriptions are prose, and prose is full of
 * number ranges that are not ages: "runs from 10 to 10:30 am", "a 4-week session",
 * "Grades 4-6", "between 6:30 - 7:30 PM". A parser that reads any `N–M` would put
 * a nine-year-old in a lap-bounce. So a range counts ONLY when the text says what
 * the numbers mean — an explicit month/year unit, "birth", or an immediately
 * preceding "age(s)" cue. Everything else is left unread, and an unread age is
 * simply the audience band, exactly as before. Measured against a live capture of
 * all three systems (2026-08-02): 40% of non-adult events state a band, 239 of
 * them narrower than their audience umbrella, and 96 stop reaching a 30-month-old
 * who never fitted them.
 *
 * The one convention worth stating: a year upper bound runs through that year's
 * last month — "5 years" is 71 months, matching `throughAge` in library-systems.
 * "under 12" is the exclusive form and stops at 143.
 */

/** A band the source stated out loud, in completed months, both ends inclusive. */
export interface StatedAgeBand {
  ageMinMonths: number;
  ageMaxMonths: number;
}

/** Past this an age is not a childhood age at all — the signal that whatever
 * matched (a year, a price, a room number) was never an age. */
const PRODUCT_AGE_CEILING_MONTHS = 18 * 12 - 1;

const MONTHS_PER_YEAR = 12;

/** Bounded so a four-digit year can never be read as an age; the trailing `\b`
 * stops "199" being taken out of "1990". */
const NUM = '(\\d{1,3})\\b';
const DASH = '(?:-|to|through|until)';
const MONTH = '(?:months?|mos?)';
const YEAR = '(?:years?|yrs?|year[\\s-]?olds?)';
const ZERO = '(?:birth|newborn)';
/** "Ages: 6-8", "Age 6-11", "the ages of 6 to 12" — the cue must sit immediately
 * before the numbers, so an "age" mentioned a sentence earlier never licenses a
 * range that is really a time. */
const AGE_CUE = '\\bages?\\b\\s*(?::|of)?\\s*';

/** How a matched endpoint converts to months. `zero` is a word ("birth"), not a
 * number; `exclusive` is the "under N" form, which stops the month BEFORE N. */
type Unit = 'zero' | 'months' | 'years' | 'years-exclusive' | 'months-exclusive';

interface Rule {
  readonly re: RegExp;
  readonly low: Unit;
  readonly high: Unit;
}

/**
 * Ordered by how much the text commits to, not by where it appears: a rule that
 * demands a unit on BOTH ends beats one that demands it on one, which beats the
 * bare "age" cue. That ordering is what makes "Ages: 0–12 months" read as months
 * rather than as the years the cue alone would imply.
 */
const RULES: readonly Rule[] = [
  { re: rx(`${NUM}\\s*${MONTH}\\s*${DASH}\\s*${NUM}\\s*${YEAR}`), low: 'months', high: 'years' },
  { re: rx(`${NUM}\\s*${MONTH}\\s*${DASH}\\s*${NUM}\\s*${MONTH}`), low: 'months', high: 'months' },
  { re: rx(`${NUM}\\s*${YEAR}\\s*${DASH}\\s*${NUM}\\s*${YEAR}`), low: 'years', high: 'years' },
  { re: rx(`${NUM}\\s*${DASH}\\s*${NUM}\\s*${MONTH}`), low: 'months', high: 'months' },
  { re: rx(`${NUM}\\s*${DASH}\\s*${NUM}\\s*${YEAR}`), low: 'years', high: 'years' },
  { re: rx(`${ZERO}\\s*${DASH}\\s*${NUM}\\s*${MONTH}`), low: 'zero', high: 'months' },
  { re: rx(`${ZERO}\\s*${DASH}\\s*${NUM}\\s*${YEAR}`), low: 'zero', high: 'years' },
  { re: rx(`${NUM}\\s*${MONTH}\\s*(?:and|or)\\s*(?:under|younger|below)`), low: 'zero', high: 'months' },
  { re: rx(`${NUM}\\s*${YEAR}\\s*(?:and|or)\\s*(?:under|younger|below)`), low: 'zero', high: 'years' },
  { re: rx(`${AGE_CUE}${NUM}\\s*(?:and|or)\\s*(?:under|younger|below)`), low: 'zero', high: 'years' },
  { re: rx(`(?:under|below|younger than)\\s*${NUM}\\s*${MONTH}`), low: 'zero', high: 'months-exclusive' },
  { re: rx(`(?:under|below|younger than)\\s*${NUM}\\s*${YEAR}`), low: 'zero', high: 'years-exclusive' },
  { re: rx(`${AGE_CUE}${NUM}\\s*${DASH}\\s*${NUM}`), low: 'years', high: 'years' },
];

function rx(source: string): RegExp {
  return new RegExp(`\\b${source}`, 'i');
}

/**
 * Strip the markup and entities these descriptions are stored with, and flatten
 * every dash and space variant the three systems use — RHPL leaves a zero-width
 * no-break space inside its own titles, and en dashes are the house style — so the
 * rules above only ever face ASCII.
 */
export function plainText(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:ndash|mdash);/gi, '-')
    .replace(/[‐-―−]/g, '-')
    .replace(/[ ​﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A stated age in months. Which END of the range it is matters for years and only
 * for years: "2–5 years" opens on the second birthday (24) and closes on the last
 * month of the fifth year (71) — the same convention `throughAge` applies to an
 * audience label.
 */
function toMonths(value: number, unit: Unit, end: 'low' | 'high'): number {
  switch (unit) {
    case 'zero':
      return 0;
    case 'months':
      return value;
    case 'months-exclusive':
      return value - 1;
    case 'years-exclusive':
      return value * MONTHS_PER_YEAR - 1;
    case 'years':
      return end === 'low' ? value * MONTHS_PER_YEAR : value * MONTHS_PER_YEAR + MONTHS_PER_YEAR - 1;
  }
}

/**
 * The age band this text states, or null when it states none. Null is NOT "all
 * ages" — it means the question went unanswered here, and the caller keeps
 * whatever it already knew.
 */
export function parseStatedAgeBand(text: string | null | undefined): StatedAgeBand | null {
  const plain = plainText(text);
  if (plain.length === 0) return null;

  for (const rule of RULES) {
    const match = rule.re.exec(plain);
    if (match === null) continue;
    const numbers = match.slice(1).filter((part): part is string => part !== undefined);
    const openEnded = rule.low === 'zero';
    const lowRaw = openEnded ? 0 : Number(numbers[0]);
    const highRaw = Number(numbers[openEnded ? 0 : 1]);
    if (!Number.isFinite(lowRaw) || !Number.isFinite(highRaw)) continue;

    const ageMinMonths = toMonths(lowRaw, rule.low, 'low');
    const ageMaxMonths = Math.min(toMonths(highRaw, rule.high, 'high'), PRODUCT_AGE_CEILING_MONTHS);
    // A backwards range, or one that starts past childhood, is not an age range —
    // it is a price, a room, or a year, and reading it would be worse than silence.
    if (ageMinMonths > ageMaxMonths) continue;
    if (ageMinMonths > PRODUCT_AGE_CEILING_MONTHS) continue;
    return { ageMinMonths, ageMaxMonths };
  }
  return null;
}
