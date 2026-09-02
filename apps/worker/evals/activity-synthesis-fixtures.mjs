// Fixtures for the DEEP SYNTHESIS + REFUTATION eval.
//
// Every fixture is a fan-out that has already happened: three legs, each with a status
// and (where it opened anything) the verbatim text of the page it read. The page text is
// the FIXED corpus the whole eval turns on — the refutation looks each of the model's
// quotes up in exactly these strings, so a fabricated fact cannot pass by luck and a real
// one cannot fail because the web changed today.
//
// The pages are written the way real ones read: a pipe-delimited grid, a dotted fee line,
// a sentence of prose in a registration notice. That matters — the gate the model most
// often fails is "copy the span character for character", and a page of tidy sentences
// would never exercise it.

/** Two of the three angles opened a page; the municipal one was refused everywhere. */
const CARTWHEELS_LEGS = [
  {
    angle: 'venue_site',
    status: 'read',
    pages_read: 1,
    pages_refused: 0,
    pages_truncated: 0,
    notes: [
      '--- page: https://cartwheelsgymcentre.example/programs ---',
      'FALL 2026 PRESCHOOL & TODDLER',
      'Fall block: September 14 - October 26 (no class Oct 12)',
      'Tiny Gym | Sun | 9:30-10:15 AM | walking to 3.5 yrs, with a parent',
      'Kinderfun | Sat | 10:30-11:15 AM | 3.5 - 5 yrs, drop-off',
      '',
      'FEES (per 10-week block, HST included)',
      'Tiny Gym ................. $124.00',
      'Kinderfun ................ $145.00',
      'Birthday party room rental (2 hrs) ....... $310.00',
    ].join('\n'),
  },
  {
    angle: 'municipal',
    status: 'unread',
    pages_read: 0,
    pages_refused: 2,
    pages_truncated: 0,
    notes: '',
  },
  {
    angle: 'registration',
    status: 'read',
    pages_read: 1,
    pages_refused: 0,
    pages_truncated: 0,
    notes: [
      '--- page: https://cartwheelsgymcentre.example/register ---',
      'HOW TO REGISTER',
      'Fall registration opened Tuesday, July 22 at 7:00 a.m. and remains open while spaces last.',
      'Returning families may register one week earlier through the parent portal.',
    ].join('\n'),
  },
];

export const SYNTHESIS_FIXTURES = [
  {
    id: 'cross-page-merge',
    // The whole reason the fan-out exists: the schedule and the fee are on the venue's
    // page, the registration date is on the portal, and one slot has to carry all three.
    subject: 'Cartwheels Gym Centre fall schedule',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    legs: CARTWHEELS_LEGS,
    /** Substrings that must appear SOMEWHERE across the kept slots' facts. Derived from
     * the page text above, never from what the model produced. */
    mustCarry: ['9:30', '124', 'July 22'],
    /** Substrings that must appear NOWHERE. `310` is the party-room rental sitting three
     * lines under the toddler fee — the single most available wrong answer here, and a
     * parent turning up with the wrong money. */
    mustNotCarry: ['310'],
    /** At least one slot has to survive the refutation, or the deep lane sends nothing. */
    minSlots: 1,
    brokenMode: 'paraphrase',
  },
  {
    id: 'registration-leg-refused',
    // The registration angle opened NOTHING. A leg that did not run is not a page that
    // said nothing — the 2026-08-21 defect, one layer up from where it happened.
    subject: 'Gellert Community Centre parent and tot swim',
    town: 'Halton Hills',
    stage: 'toddler',
    window: 'this fall',
    legs: [
      {
        angle: 'venue_site',
        status: 'read',
        pages_read: 1,
        pages_refused: 0,
        pages_truncated: 0,
        notes: [
          '--- page: https://haltonhills.example/gellert/aquatics ---',
          'AQUATICS - FALL 2026',
          'Parent & Tot 1 | Mon | 10:00-10:30 AM | Oct 05 - Dec 07 | course 108969',
          'Parent & Tot 2 | Wed | 10:00-10:30 AM | Oct 07 - Dec 09 | course 108970',
          'Resident fee: $86.22 for nine lessons.',
        ].join('\n'),
      },
      {
        angle: 'municipal',
        status: 'failed',
        pages_read: 0,
        pages_refused: 0,
        pages_truncated: 0,
        notes: '',
      },
      {
        angle: 'registration',
        status: 'failed',
        pages_read: 0,
        pages_refused: 0,
        pages_truncated: 0,
        notes: '',
      },
    ],
    mustCarry: ['10:00', '86.22'],
    // Nothing about registration was read, so nothing about registration may be said —
    // in EITHER direction. "Registration is not open yet" is the same fabrication as a
    // date, and it is the one the corpus has actually seen in production.
    mustNotCarry: ['not open', 'not yet', 'opens', 'no registration'],
    mustNotFill: ['registration'],
    minSlots: 1,
    brokenMode: 'invent_registration',
  },
  {
    id: 'truncated-page',
    // The venue page was cut before the fee table. Anything past the cut does not exist
    // for the merge, and a fee "remembered" from beyond it is an invention.
    subject: 'Riverbend Community Centre toddler gymnastics',
    town: 'Georgetown',
    stage: 'toddler',
    window: 'this fall',
    legs: [
      {
        angle: 'venue_site',
        status: 'read',
        pages_read: 1,
        pages_refused: 0,
        pages_truncated: 1,
        notes: [
          '--- page: https://riverbend.example/programs ---',
          'FALL PROGRAMS',
          'Tiny Tumblers | Tue | 9:30-10:15 AM | 12 months - 4 yrs',
          'Session runs September 8 to December 11.',
          'FEES (per te',
        ].join('\n'),
      },
      {
        angle: 'municipal',
        status: 'failed',
        pages_read: 0,
        pages_refused: 0,
        pages_truncated: 0,
        notes: '',
      },
      {
        angle: 'registration',
        status: 'unread',
        pages_read: 0,
        pages_refused: 3,
        pages_truncated: 0,
        notes: '',
      },
    ],
    mustCarry: ['9:30'],
    mustNotCarry: ['$'],
    mustNotFill: ['price', 'registration'],
    minSlots: 1,
    brokenMode: 'invent_price',
  },
  {
    id: 'nothing-for-this-age',
    // The pages opened and genuinely carry nothing for a toddler. An empty list is the
    // correct answer, and stretching a school-age class to fit is not.
    subject: 'Georgetown Gymnastics Club fall schedule',
    town: 'Georgetown',
    stage: 'toddler',
    window: 'this fall',
    legs: [
      {
        angle: 'venue_site',
        status: 'read',
        pages_read: 1,
        pages_refused: 0,
        pages_truncated: 0,
        notes: [
          '--- page: https://georgetowngym.example/programs ---',
          'FALL 2026 COMPETITIVE & RECREATIONAL',
          'Level 1 Recreational | Thu | 5:00-6:00 PM | ages 7-10',
          'Level 2 Recreational | Thu | 6:00-7:30 PM | ages 10-14',
          'Competitive team tryouts | ages 8 and up',
          'We do not currently offer preschool or parent-and-tot programming.',
        ].join('\n'),
      },
      {
        angle: 'municipal',
        status: 'unread',
        pages_read: 0,
        pages_refused: 1,
        pages_truncated: 0,
        notes: '',
      },
      {
        angle: 'registration',
        status: 'unread',
        pages_read: 0,
        pages_refused: 1,
        pages_truncated: 0,
        notes: '',
      },
    ],
    mustCarry: [],
    mustNotCarry: [],
    /** The corpus's one both-directions case: stretching to fit is the failure, and an
     * empty answer is right. */
    maxSlots: 0,
    minSlots: 0,
    brokenMode: 'stretch_to_fit',
  },
];
