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
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
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
        { name: null, ageMonths: 48, agePrecision: 'years' },
        { name: null, ageMonths: 12, agePrecision: 'years' },
      ],
      postalCode: null,
    },
  },
  {
    id: 'word-age-no-name',
    message: 'my son is four',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: null, ageMonths: 48, agePrecision: 'years' }], postalCode: null },
  },
  {
    id: 'months-and-typo',
    message: 'Sofi is 18 months, adress is m5v2t6',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Sofi', ageMonths: 18, agePrecision: 'months' }], postalCode: 'M5V 2T6' },
  },
  {
    id: 'french',
    message: "J'ai deux enfants, Amélie a 6 ans et Luc a 3 ans. Code postal H2X 1Y4",
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Amélie', ageMonths: 72, agePrecision: 'years' },
        { name: 'Luc', ageMonths: 36, agePrecision: 'years' },
      ],
      postalCode: 'H2X 1Y4',
    },
  },
  {
    id: 'accumulate-names-onto-known-ages',
    message: 'the older one is Maya, the little one is Leo',
    alreadyKnown: {
      children: [
        { name: null, age_months: 48, age_precision: 'years' },
        { name: null, age_months: 12, age_precision: 'years' },
      ],
      postal_code: null,
    },
    // The whole point of accumulation: the earlier ages AND their granularity must
    // survive this turn — a precision dropped here is a six-month error at provisioning.
    expect: {
      children: [
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
      ],
      postalCode: null,
    },
  },
  {
    id: 'accumulate-postal-only',
    message: 'M4K 1N2',
    alreadyKnown: {
      children: [{ name: 'Ravi', age_months: 60, age_precision: 'years' }],
      postal_code: null,
    },
    expect: {
      children: [{ name: 'Ravi', ageMonths: 60, agePrecision: 'years' }],
      postalCode: 'M4K 1N2',
    },
  },
  {
    id: 'newborn',
    message: 'just one, she was born 6 weeks ago. L7G 4S8',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [{ name: null, ageMonths: 1, agePrecision: 'months' }],
      postalCode: 'L7G 4S8',
      ageToleranceMonths: 2,
    },
  },
  {
    id: 'half-year',
    message: 'Theo is 3 and a half, Nina just turned 6, we are at K1A 0B1',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [
        { name: 'Theo', ageMonths: 42, agePrecision: 'months' },
        { name: 'Nina', ageMonths: 72, agePrecision: 'months' },
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
        { name: 'Max', ageMonths: 48, agePrecision: 'years' },
        { name: 'Mia', ageMonths: 18, agePrecision: 'months' },
      ],
      postalCode: 'L3R',
    },
  },
  {
    id: 'fsa-lowercase',
    message: 'Ava is 6, l3r',
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Ava', ageMonths: 72, agePrecision: 'years' }], postalCode: 'L3R' },
  },
  {
    id: 'fsa-in-prose',
    message: "Noah just turned 2 and we're over in the L6C area",
    alreadyKnown: { children: [], postal_code: null },
    expect: { children: [{ name: 'Noah', ageMonths: 24, agePrecision: 'months' }], postalCode: 'L6C' },
  },
  {
    id: 'neighbourhood-not-a-postal-code',
    message: "Ines is 7, we're near the Danforth",
    alreadyKnown: { children: [], postal_code: null },
    // A place name is NOT a postal code. Inventing one puts a family in the wrong
    // part of the city — the failure this fixture exists to catch.
    expect: { children: [{ name: 'Ines', ageMonths: 84, agePrecision: 'years' }], postalCode: null },
  },
  {
    id: 'grade-reference',
    message: 'Omar is in grade 2. Postal M6K 3P6',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [{ name: 'Omar', ageMonths: 88, agePrecision: 'months' }],
      postalCode: 'M6K 3P6',
      ageToleranceMonths: 8,
    },
  },
  // ── age-granularity battery (VIL-260) — the field that decides whether the stored
  // date of birth gets the year-band midpoint correction. Getting `age_precision`
  // wrong is a silent six-month error the parent can never see and never correct, so
  // each of these pins a phrasing that a bare `age_months` cannot distinguish.
  {
    id: 'almost-three',
    message: "Zaid is almost 3, we're in M4K 1N2",
    alreadyKnown: { children: [], postal_code: null },
    // "almost 3" is the parent narrowing it themselves — the number IS the estimate,
    // so nothing downstream may age him another half-year on top.
    expect: {
      children: [{ name: 'Zaid', ageMonths: 33, agePrecision: 'months' }],
      postalCode: 'M4K 1N2',
      ageToleranceMonths: 3,
    },
  },
  {
    id: 'two-and-a-half',
    message: 'Priya is 2 and a half. L3R',
    alreadyKnown: { children: [], postal_code: null },
    expect: {
      children: [{ name: 'Priya', ageMonths: 30, agePrecision: 'months' }],
      postalCode: 'L3R',
    },
  },
  {
    id: 'upcoming-birthday',
    message: 'Hugo is turning 4 in October. M6K 3P6',
    alreadyKnown: { children: [], postal_code: null },
    // He is 3 today, and the skill has no clock — so the honest read is the year he is
    // NOW, at year granularity. Guessing how close October is would invent a month.
    expect: {
      children: [{ name: 'Hugo', ageMonths: 36, agePrecision: 'years' }],
      postalCode: 'M6K 3P6',
    },
  },
  {
    id: 'named-but-ageless',
    message: 'Nora and Ben, M5V 2T6',
    alreadyKnown: { children: [], postal_code: null },
    // Two children and not one age between them. A number invented here becomes a
    // stored date of birth, so `null` has to survive the whole way out.
    expect: {
      children: [
        { name: 'Nora', ageMonths: null, agePrecision: null },
        { name: 'Ben', ageMonths: null, agePrecision: null },
      ],
      postalCode: 'M5V 2T6',
    },
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
