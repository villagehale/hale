// VIL-238 · M3 radar COMPOSE fixtures.
//
// Each fixture is a DECISION OBJECT — exactly what the deterministic DECIDE cascade
// emits and the only thing the composer ever sees. The corpus spans the four axes the
// M3 brief names, because each one changes what an honest message may say:
//
//   family size      1 / 2 / 3 kids   (multi-kid discipline: ONE message, one pick)
//   registration     present / absent (an absent window must be said lightly, not implied)
//   weather          good / bad / unavailable
//                    (good → the pick may claim a dry forecast; bad → the decision
//                     already chose indoors and there is NO weather fact to state;
//                     unavailable → an outdoor pick with no weather claim at all)
//   village data     rich / thin      (thin → no pick exists, and none may be invented)
//
// `expect.mustRecall` tokens are derived from the DECISION, never from model output:
// a message that drops the one fact it exists to deliver has failed regardless of how
// nice it reads.

/** The exact question the state machine appends after the composed message. Mirrors
 * WATCH_OFFER in apps/web/lib/channel/intake/copy.ts — the composer must never write it.
 * Onboarding script v2 moved the privacy link here from the greeting's disclosure, which
 * is why the appended tail is now 119 septets rather than 46. */
export const WATCH_OFFER =
  "Want me to keep an eye on all of this for you? (how I handle your family's info: https://www.villagehale.com/privacy)";

function pick(over = {}) {
  return {
    candidateRef: { id: 'cand-1', title: 'Riverdale Farm drop-in', venueName: 'Riverdale Farm' },
    day: 'saturday',
    kidNames: ['Maya'],
    whyFacts: ['free', 'outdoor', 'the forecast looks dry'],
    ...over,
  };
}

function registration(over = {}) {
  return {
    windowRef: { municipality: 'markham', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
    opensAtLocal: 'Aug 11, 6:30 a.m.',
    kidNames: ['Maya'],
    residentNote: null,
    ageApproximate: false,
    ...over,
  };
}

function decision(weekendPick, registrationLine) {
  return {
    weekendPick,
    registrationLine,
    offerQuestion: true,
    followUpNeeded: weekendPick === null,
  };
}

export const RADAR_FIXTURES = [
  {
    id: '1kid-window-weather-good-village-rich',
    decision: decision(pick(), registration()),
    expect: { mustRecall: ['Riverdale', '6:30'] },
  },
  {
    id: '1kid-no-window-weather-good-village-rich',
    decision: decision(pick(), null),
    expect: { mustRecall: ['Riverdale'] },
  },
  {
    id: '1kid-window-village-thin',
    // Discovery has not landed yet. There is nothing to pick and nothing to invent.
    decision: decision(null, registration()),
    expect: { mustRecall: ['6:30'], forbidden: ['drop-in', 'playground', 'library'] },
  },
  {
    id: '1kid-nothing-at-all',
    decision: decision(null, null),
    expect: { forbidden: ['drop-in', 'library', 'swim', 'registration opens'] },
  },
  {
    id: '2kid-both-kids-weather-bad-indoor',
    // A wet weekend: DECIDE already chose indoors, and there is no weather fact to say.
    decision: decision(
      pick({
        candidateRef: { id: 'c2', title: 'Central Library story time', venueName: 'Toronto Public Library' },
        day: 'sunday',
        kidNames: ['Maya', 'Leo'],
        whyFacts: ['free', 'indoor', 'for 1-5 years'],
      }),
      registration({ kidNames: ['Maya'] }),
    ),
    expect: {
      mustRecall: ['Maya', 'Leo', 'story time'],
      forbidden: ['sunny', 'dry', 'rain', 'outdoor'],
    },
  },
  {
    id: '2kid-weather-unavailable-no-window',
    // No forecast at all: an outdoor pick still stands, but claims nothing about the sky.
    decision: decision(
      pick({
        candidateRef: { id: 'c3', title: 'High Park playground meetup', venueName: null },
        kidNames: ['Ada', 'Noor'],
        whyFacts: ['free', 'outdoor'],
      }),
      null,
    ),
    expect: { mustRecall: ['High Park'], forbidden: ['dry', 'sunny', 'forecast'] },
  },
  {
    id: '2kid-paid-pick-resident-head-start',
    decision: decision(
      pick({
        candidateRef: { id: 'c4', title: 'Family swim', venueName: 'Angus Glen Community Centre' },
        day: 'sunday',
        kidNames: ['Maya', 'Leo'],
        whyFacts: ['paid ($$)', 'indoor', 'for all ages'],
      }),
      registration({ residentNote: 'residents can register first' }),
    ),
    expect: { mustRecall: ['Family swim', '6:30'], forbidden: ['free'] },
  },
  {
    id: '3kid-one-voice-window-present',
    // Three kids, three age bands, ONE pick. The message must not fan out per child.
    decision: decision(
      pick({
        candidateRef: { id: 'c5', title: 'Kids climbing session', venueName: null },
        day: 'saturday',
        kidNames: ['Sam'],
        whyFacts: ['paid ($)', 'indoor', 'for 8-12 years'],
      }),
      registration({ kidNames: ['Maya', 'Leo'] }),
    ),
    expect: { mustRecall: ['climbing', '6:30'] },
  },
  {
    id: '3kid-village-thin-approximate-age',
    decision: decision(null, registration({ kidNames: ['Maya', 'Leo', 'Sam'], ageApproximate: true })),
    expect: { mustRecall: ['6:30'], forbidden: ['drop-in', 'library'] },
  },
  {
    id: '1kid-pick-with-no-venue',
    // venueName is null: naming a venue here would be a straight invention.
    decision: decision(
      pick({
        candidateRef: { id: 'c6', title: 'Neighbourhood skating drop-in', venueName: null },
        whyFacts: ['free', 'outdoor'],
      }),
      null,
    ),
    expect: { mustRecall: ['skating'] },
  },
  {
    id: '1kid-unnamed-child',
    // The parent described a child without naming one. No name may be invented for them.
    decision: decision(
      pick({ kidNames: [], whyFacts: ['free', 'outdoor', 'the forecast looks dry'] }),
      registration({ kidNames: [] }),
    ),
    expect: { mustRecall: ['Riverdale', '6:30'] },
  },
  {
    id: '2kid-pick-only-window-absent',
    decision: decision(
      pick({
        candidateRef: { id: 'c7', title: 'Evergreen Brick Works family walk', venueName: 'Evergreen Brick Works' },
        day: 'sunday',
        kidNames: ['Ada', 'Noor'],
        whyFacts: ['free', 'outdoor', 'the forecast looks dry'],
      }),
      null,
    ),
    expect: { mustRecall: ['Evergreen'] },
  },
];
