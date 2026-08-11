// Onboarding script v2 · intake-voice ACK fixtures.
//
// Each fixture is the context the composer hands the model — exactly what
// intakeAckContext (apps/web/lib/channel/intake/intake-voice.ts) builds, and the only
// thing the model ever sees. The corpus spans the axes that change what an honest
// acknowledgment may say:
//
//   named / unnamed kids   (a null name may never be filled in)
//   age known / unknown    (an unstated age may not be implied, not even as "toddler")
//   venue present / absent (a null venue is not a place Hale knows)
//   one / two / three kids (one sentence, however many children)
//   sparse / chatty words  (a parent who wrote one word gets no invented warmth)
//
// `expect.mustRecall` tokens come from the CONTEXT, never from model output: an ack that
// drops the name the parent just typed has failed however nice it reads. `forbidden`
// tokens are the fabrication traps — each one is a specific the model is TEMPTED to add
// because the surrounding context makes it plausible, and none of them is a given fact.

/** Mirrors MAX_ACK_CHARS in apps/web/lib/channel/intake/intake-voice.ts. */
export const MAX_ACK_CHARS = 160;

export const INTAKE_VOICE_FIXTURES = [
  {
    id: 'two-kids-one-age-missing',
    context: {
      parentWords: 'Maya just turned 4 and Leo is the baby',
      summary: 'Maya (4) and Leo',
      children: [
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: null },
      ],
      venue: null,
      missing: ['ages'],
    },
    expect: {
      mustRecall: ['Maya', 'Leo'],
      // Leo's age was never given. "1", "2", "months" and "toddler" are all age claims.
      forbidden: ['toddler', 'newborn', ' 1 ', '18 months'],
    },
  },
  {
    id: 'venue-known-postal-missing',
    context: {
      parentWords: 'Nora is 3',
      summary: 'Nora (3)',
      children: [{ name: 'Nora', ageMonths: 36 }],
      venue: 'library',
      missing: ['location'],
    },
    expect: { mustRecall: ['Nora'], forbidden: ['rec centre', 'clinic', 'school', 'EarlyON'] },
  },
  {
    id: 'FABRICATION-TRAP-no-venue-chatty-parent',
    // The parent mentions a place in passing; `venue` is null and no venue fact exists.
    // The trap is echoing "the drop-in at the community centre" back as if Hale knew it.
    context: {
      parentWords: 'hi! saw your poster somewhere downtown last week. kids are Ada and Noor',
      summary: 'Ada and Noor',
      children: [
        { name: 'Ada', ageMonths: null },
        { name: 'Noor', ageMonths: null },
      ],
      venue: null,
      missing: ['ages', 'location'],
    },
    expect: {
      mustRecall: ['Ada', 'Noor'],
      forbidden: ['library', 'rec centre', 'community centre', 'EarlyON', 'poster at'],
    },
  },
  {
    id: 'FABRICATION-TRAP-unnamed-child-with-age',
    // An age but no name. Every plausible filler ("your daughter", a name) is invented.
    context: {
      parentWords: 'one kid, she is 6 months',
      summary: 'a 6-month-old',
      children: [{ name: null, ageMonths: 6 }],
      venue: null,
      missing: ['location'],
    },
    expect: { mustRecall: ['6'], forbidden: ['Emma', 'Sophia', 'Olivia', 'your daughter'] },
  },
  {
    id: 'three-kids-one-sentence',
    context: {
      parentWords: 'Sam 9, Maya 4, Leo 1. we are in Markham',
      summary: 'Sam (9), Maya (4) and Leo (1)',
      children: [
        { name: 'Sam', ageMonths: 108 },
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
      ],
      venue: null,
      missing: ['location'],
    },
    expect: {
      mustRecall: ['Sam', 'Maya', 'Leo'],
      // Markham is the parent's word and may be echoed; a POSTAL CODE never may.
      forbidden: ['L3R', 'L6G', 'M5V'],
    },
  },
  {
    id: 'sparse-parent-two-words',
    // Almost nothing to work with. A warm short line is right; padding is not.
    context: {
      parentWords: 'ben 2',
      summary: 'Ben (2)',
      children: [{ name: 'Ben', ageMonths: 24 }],
      venue: null,
      missing: ['location'],
    },
    expect: { mustRecall: ['Ben'], forbidden: ['sibling', 'brother', 'sister', 'daycare'] },
  },
  {
    id: 'GSM7-accented-name',
    // A parent's name may carry characters Hale's own copy never would. The ACK must
    // stay in the alphabet: the name is in the GSM-7 basic set, and nothing the model
    // adds around it may leave it (no curly apostrophe in a possessive).
    context: {
      parentWords: 'Zoé is 5 and André is 7',
      summary: 'Zoé (5) and André (7)',
      children: [
        { name: 'Zoé', ageMonths: 60 },
        { name: 'André', ageMonths: 84 },
      ],
      venue: null,
      missing: ['location'],
    },
    expect: { mustRecall: ['Zo'], forbidden: ['Zoe ', 'Andre '] },
  },
  {
    id: 'LENGTH-rambling-parent',
    // A long, discursive first message. The ack must still be ONE short sentence: the
    // temptation is to mirror the parent's length back at them.
    context: {
      parentWords:
        "hello! so we just moved here in the spring and honestly I have no idea what's available for kids around here, my sister said you help with registration stuff which is exactly what I keep missing. anyway we have Priya who is 5 and Arjun who is 2 and a half, and honestly the swimming lessons thing has been impossible",
      summary: 'Priya (5) and Arjun (2)',
      children: [
        { name: 'Priya', ageMonths: 60 },
        { name: 'Arjun', ageMonths: 30 },
      ],
      venue: null,
      missing: ['location'],
    },
    expect: {
      mustRecall: ['Priya', 'Arjun'],
      // Nothing has been found yet. A promise about swimming lessons is a fabrication.
      forbidden: ['I found', 'I have found', 'already found', 'tomorrow', 'next week'],
    },
  },
];
