// The per-word half of the coach-channel fabrication gate: is this capitalised word a
// claim about THIS FAMILY that Hale was never handed?
//
// Extracted from run-coach-channel-eval.mjs so the normaliser can be tested directly.
// The gate reads a composed SMS body. A trim used to cut mid-sentence and append an
// ellipsis, and a model can still end a word that way, so the punctuation a name
// arrives wearing may not be the model's. A normaliser that only recognises a
// possessive at the very end of the word flagged "Remy's..." as an invented name
// while Remy sat in the fixture's own children (#411).

/**
 * Public-health authorities the coach may name.
 *
 * Less an exemption than a statement of what this gate is FOR. An invented capitalised
 * word matters because it is a claim about THIS FAMILY — a pool they do not swim at, a
 * teacher they have never met — and over SMS there is nothing around it to correct it.
 * "Health Canada recommends around six months" is a claim about the world, and it is the
 * shape the sibling skill explicitly asks for ("name the source when the claim is a
 * checkable fact", general-answer.md); the companion returns CONFIRM_WITH_PROVIDER on
 * every health item for the same reason — so guidance can be attributed rather than
 * asserted in Hale's own voice.
 *
 * Scoped to Hale's jurisdiction, in both the forms English uses for it — the compliance
 * baseline is Canada (hard rule #1), so this is the only country whose guidance the coach
 * has any business citing, and "Health Canada" and "most Canadian paediatricians" are the
 * same citation with different grammar. Naming the boundary that way is what keeps this
 * from becoming a list of whatever the model said last: a second country appearing here
 * would be a product decision, not a grading one.
 *
 * CLOSED on purpose. An open "looks like an institution" rule would wave through the
 * invented study or the made-up clinic, which is a fabrication this gate must still catch.
 */
const CITEABLE_AUTHORITIES = new Set(['Canada', 'Canadian']);

/** Capitalised words that are not claims about this family's week. */
const ALLOWED_CAPS = new Set([
  'Hale',
  'I',
  'A',
  'An',
  'The',
  'And',
  'But',
  'So',
  'If',
  'It',
  'Want',
  'Which',
  'More',
  'Reply',
  'Your',
  'Nothing',
]);

/**
 * The name this word is making a claim about, or `null` when it makes none — because it
 * is not a capitalised name, because it is on one of the two lists above, or because the
 * name is in `hay` and so was recalled rather than invented.
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/g;

/**
 * Is this weekday name backed by a date Hale was handed? Only if some month-day date in
 * `hay` actually FALLS on that weekday in `year`, computed from the calendar rather than
 * by aliasing "Sunday" to "Sun": a reply that calls Aug 9 2026 a Sunday is recall, and
 * one that calls it a Saturday is a wrong fact even though "sat" is in the hay elsewhere.
 */
export function weekdayGrounded(day, hay, year) {
  const target = WEEKDAYS.indexOf(day.toLowerCase());
  if (target < 0 || !Number.isInteger(year)) return false;
  for (const match of hay.toLowerCase().matchAll(MONTH_DAY)) {
    const month = MONTHS.indexOf(match[1]);
    const date = Number(match[2]);
    const at = new Date(Date.UTC(year, month, date));
    if (at.getUTCMonth() !== month) continue;
    if (at.getUTCDay() === target) return true;
  }
  for (const match of hay.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (at.getUTCDay() === target) return true;
  }
  return false;
}

export function inventedName(word, hay, year) {
  const bare = word
    .replace(/^[^A-Za-z]+/, '')
    // Punctuation first, then the possessive it was hiding. The other order only ever
    // saw a possessive that ended the word, so an ellipsis or a closing quote after it
    // left the `'s` attached to the name and no name matches with one on the end.
    .replace(/[^A-Za-z'’]+$/, '')
    .replace(/['’]s?$/i, '');
  if (!/^[A-Z][a-z]/.test(bare)) return null;
  if (ALLOWED_CAPS.has(bare) || CITEABLE_AUTHORITIES.has(bare)) return null;
  if (WEEKDAYS.includes(bare.toLowerCase())) {
    // Named outright in what Hale was handed (the parent's own "move Thursday"), or the
    // real weekday of a date it was handed. Never an abbreviation alias.
    if (hay.includes(bare.toLowerCase())) return null;
    return weekdayGrounded(bare, hay, year) ? null : bare;
  }
  return hay.includes(bare.toLowerCase()) ? null : bare;
}
