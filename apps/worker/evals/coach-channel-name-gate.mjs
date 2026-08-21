// The per-word half of the coach-channel fabrication gate: is this capitalised word a
// claim about THIS FAMILY that Hale was never handed?
//
// Extracted from run-coach-channel-eval.mjs so the normaliser can be tested directly.
// The gate reads a composed SMS body, which is a TRIMMED body — the 2-segment budget
// cuts mid-sentence and appends an ellipsis — so the punctuation a name arrives wearing
// is the harness's own, not the model's. A normaliser that only recognises a possessive
// at the very end of the word flagged "Remy's..." as an invented name while Remy sat in
// the fixture's own children (#411).

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
export function inventedName(word, hay) {
  const bare = word
    .replace(/^[^A-Za-z]+/, '')
    // Punctuation first, then the possessive it was hiding. The other order only ever
    // saw a possessive that ended the word, so an ellipsis or a closing quote after it
    // left the `'s` attached to the name and no name matches with one on the end.
    .replace(/[^A-Za-z'’]+$/, '')
    .replace(/['’]s?$/i, '');
  if (!/^[A-Z][a-z]/.test(bare)) return null;
  if (ALLOWED_CAPS.has(bare) || CITEABLE_AUTHORITIES.has(bare)) return null;
  return hay.includes(bare.toLowerCase()) ? null : bare;
}
