// VIL-237 · M2 conversational SMS intake — eval corpus.
//
// PII (rule #1): every message here is synthetic. Names are invented, postal codes are
// real-shaped but not tied to anyone, and nothing in the corpus came from a real family.
//
// Expectations are derived from the SPEC (packages/agent/skills/intake-extraction.md and
// reply-intent.md), not from what the model happened to answer — the ages below are what
// the skill's conversion table says they must be, and the intents are what the skill's
// "what is NOT assent" section says they must be.

/** Extraction fixtures: a message, what is already known, what must come out. */
export const EXTRACTION_FIXTURES = [
  {
    id: 'clean-two-kids',
    message: 'Maya is 4 and Leo is 1. M5V 2T6',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
      ],
      postalCode: 'M5V 2T6',
    },
  },
  {
    id: 'bare-ages-no-names',
    message: '4 and 1',
    alreadyKnown: { children: [], postal_code: null },
    // "4 and 1" is two children whose names we were not told — NOT one child named "4".
    expect: {
      children: [
        { name: null, ageMonths: 48 },
        { name: null, ageMonths: 12 },
      ],
      postalCode: null,
    },
  },
  {
    id: 'word-age-no-name',
    message: 'my son is four',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: null, ageMonths: 48 }], postalCode: null },
  },
  {
    id: 'months-and-typo',
    message: 'Sofi is 18 months, adress is m5v2t6',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Sofi', ageMonths: 18 }], postalCode: 'M5V 2T6' },
  },
  {
    id: 'french',
    message: "J'ai deux enfants, Amélie a 6 ans et Luc a 3 ans. Code postal H2X 1Y4",
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Amélie', ageMonths: 72 },
        { name: 'Luc', ageMonths: 36 },
      ],
      postalCode: 'H2X 1Y4',
    },
  },
  {
    id: 'accumulate-names-onto-known-ages',
    message: 'the older one is Maya, the little one is Leo',
    alreadyKnown: {
      children: [
        { name: null, age_months: 48 },
        { name: null, age_months: 12 },
      ],
      postal_code: null,
    },
    // The whole point of accumulation: the earlier ages must survive this turn.
    expect: {
      children: [
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
      ],
      postalCode: null,
    },
  },
  {
    id: 'accumulate-postal-only',
    message: 'M4K 1N2',
    alreadyKnown: {
      children: [{ name: 'Ravi', age_months: 60 }],
      postal_code: null,
    },
    expect: { children: [{ name: 'Ravi', ageMonths: 60 }], postalCode: 'M4K 1N2' },
  },
  {
    id: 'newborn',
    message: 'just one, she was born 6 weeks ago. L7G 4S8',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: null, ageMonths: 1 }], postalCode: 'L7G 4S8', ageToleranceMonths: 2 },
  },
  {
    id: 'half-year',
    message: 'Theo is 3 and a half, Nina just turned 6, we are at K1A 0B1',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Theo', ageMonths: 42 },
        { name: 'Nina', ageMonths: 72 },
      ],
      postalCode: 'K1A 0B1',
      ageToleranceMonths: 3,
    },
  },
  // ── FSA battery (VIL-254) — decision D2: the first three characters ARE the
  // answer. The demo message below was refused in prod, which is what these three
  // fixtures exist to keep from happening again. The `neighbourhood-not-a-postal-code`
  // fixture below is the calibration in the other direction: widening acceptance to
  // three characters must not make a place name acceptable.
  {
    id: 'fsa-only',
    message: 'Max is 4, Mia is 18 months, L3R',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Max', ageMonths: 48 },
        { name: 'Mia', ageMonths: 18 },
      ],
      postalCode: 'L3R',
    },
  },
  {
    id: 'fsa-lowercase',
    message: 'Ava is 6, l3r',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Ava', ageMonths: 72 }], postalCode: 'L3R' },
  },
  {
    id: 'fsa-in-prose',
    message: "Noah just turned 2 and we're over in the L6C area",
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Noah', ageMonths: 24 }], postalCode: 'L6C' },
  },
  {
    id: 'neighbourhood-not-a-postal-code',
    message: "Ines is 7, we're near the Danforth",
    alreadyKnown: { children: [], postal_code: null },
    // A place name is NOT a postal code. Inventing one puts a family in the wrong
    // part of the city — the failure this fixture exists to catch.
    expect: { children: [{ name: 'Ines', ageMonths: 84 }], postalCode: null },
  },
  {
    id: 'grade-reference',
    message: 'Omar is in grade 2. Postal M6K 3P6',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Omar', ageMonths: 88 }], postalCode: 'M6K 3P6', ageToleranceMonths: 8 },
  },
  {
    id: 'unreadable',
    message: 'asdkjh ???',
    alreadyKnown: { children: [], postal_code: null },
    // Nothing readable. Returning a phantom child would provision an empty row.
    expect: { children: [], postalCode: null },
  },
];

/**
 * Intent fixtures for the watch-offer. The `falsePositive` group is the point of this
 * suite: none of them may ever read as `assent`, because that would manufacture a
 * consent record for a family who never agreed.
 */
export const INTENT_QUESTION = 'Want me to keep an eye on all of this for you?';

export const INTENT_FIXTURES = [
  { id: 'yes-plain', reply: 'yes', expect: 'assent' },
  { id: 'yes-please', reply: 'yes please, I need all the help I can get', expect: 'assent' },
  { id: 'yep', reply: 'yep!', expect: 'assent' },
  { id: 'go-ahead', reply: 'sure, go ahead', expect: 'assent' },
  { id: 'oui', reply: 'oui merci', expect: 'assent' },
  { id: 'sounds-good', reply: 'that would be great honestly', expect: 'assent' },

  { id: 'no-plain', reply: 'no', expect: 'decline' },
  { id: 'no-thanks', reply: "no thanks, we're good", expect: 'decline' },
  { id: 'rather-not', reply: "I'd rather not right now", expect: 'decline' },
  { id: 'non', reply: 'non merci', expect: 'decline' },
  { id: 'no-with-question', reply: 'no — what would you even watch?', expect: 'decline' },

  // ── false-positive battery: none of these is consent ──
  { id: 'fp-thanks', reply: 'thanks!', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-ok', reply: 'ok', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-question-what', reply: 'what would you be watching?', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-question-cost', reply: 'how much does this cost?', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-question-human', reply: 'is this a real person?', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-maybe', reply: 'maybe, let me ask my husband', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-conditional', reply: "I guess? depends if it's free", expect: 'ambiguous', falsePositive: true },
  { id: 'fp-more-detail', reply: 'also we have a third, he is 7', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-postal', reply: 'M5V 2T6', expect: 'ambiguous', falsePositive: true },
  { id: 'fp-thumbsup', reply: '👍', expect: 'ambiguous', falsePositive: true },
];
