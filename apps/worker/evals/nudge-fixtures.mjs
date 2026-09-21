// VIL-239 · M4 proactive-nudge COMPOSE fixtures.
//
// Each fixture is a NUDGE — exactly what the deterministic selector emits and the only
// thing the composer ever sees — or `null`, meaning the composer must never run at all.
//
// The corpus spans what actually changes an honest message:
//
//   kind          registration / weather_swap / weekday_dropin
//                                                (a deadline, an offer, a standing slot)
//   family size   1 / 2 / 3 kids               (ONE message, every kid named in line)
//   absences      no venue / no kid names / approximate age
//   weather       wet / cold / dry             (the swap must say WHICH fact it acts on;
//                                               "cold" rendered as "rain" is a fabrication
//                                               even when the swap itself is right)
//   silence       nothing worth saying, and a family that pressed STOP
//
// The last two carry `expect.neverComposes`. They are not model tests: they lock the
// invariant that COMPOSE is downstream of BOTH the outbound gate and a non-null
// decision (apps/web/lib/channel/nudge/run.ts), so a regression that composed first and
// checked later would fail here as well as in the vitest suite.

/** The CASL line the sender appends after the composed message. Mirrors NUDGE_OPT_OUT
 * in apps/web/lib/channel/nudge/nudge-voice.ts — the composer must never write it. */
export const NUDGE_OPT_OUT = 'Reply STOP to opt out.';

function registration(over = {}) {
  return {
    kind: 'registration',
    windowRef: {
      id: 'w-1',
      municipality: 'richmond_hill',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    },
    opensAtLocal: 'Aug 5, 10:30 a.m.',
    kidNames: ['Maya'],
    residentNote: null,
    ageApproximate: false,
    ...over,
  };
}

function swap(over = {}) {
  return {
    kind: 'weather_swap',
    candidateRef: {
      id: 'cand-1',
      title: 'Central Library story time',
      venueName: 'Toronto Public Library',
    },
    day: 'saturday',
    kidNames: ['Maya'],
    weatherFact: 'the weekend forecast is wet',
    whyFacts: ['free', 'indoor'],
    ...over,
  };
}

function dropIn(over = {}) {
  return {
    kind: 'weekday_dropin',
    candidateRef: {
      id: 'civic-1',
      title: 'EarlyON drop-in',
      venueName: 'Armour Heights',
    },
    eventDate: '2026-08-04',
    weekday: 'tuesday',
    kidNames: ['Mia'],
    ...over,
  };
}

export const NUDGE_FIXTURES = [
  {
    id: '1kid-window-soon',
    nudge: registration(),
    gateAllowed: true,
    expect: { mustRecall: ['Richmond Hill', '10:30'], forbidden: ['weekend', 'forecast'] },
  },
  {
    id: '2kid-window-soon-resident-head-start',
    nudge: registration({
      kidNames: ['Maya', 'Leo'],
      residentNote: 'residents can register first',
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Maya', 'Leo', '10:30'] },
  },
  {
    id: '3kid-window-soon-approximate-age',
    // Three kids, ONE message. The age match rests on a guess, so the copy must hedge
    // rather than assert the band.
    nudge: registration({
      cycleLabel: 'Winter 2027',
      windowRef: {
        id: 'w-2',
        municipality: 'markham',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027',
      },
      kidNames: ['Maya', 'Leo', 'Sam'],
      ageApproximate: true,
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Markham', '10:30'], forbidden: ['forecast'] },
  },
  {
    id: 'weather-swap-wet-indoor',
    nudge: swap({ kidNames: ['Maya', 'Leo'] }),
    gateAllowed: true,
    expect: { mustRecall: ['story time'], forbidden: ['sunny', 'dry', 'cold'] },
  },
  {
    id: 'weather-swap-cold-indoor',
    // COLD, not wet. Saying "rain" here would be a fabrication with a correct conclusion.
    nudge: swap({
      candidateRef: { id: 'cand-2', title: 'Family swim', venueName: 'Angus Glen Community Centre' },
      day: 'sunday',
      weatherFact: 'the weekend forecast is cold',
      whyFacts: ['paid ($$)', 'indoor'],
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Family swim'], forbidden: ['rain', 'wet', 'free'] },
  },
  {
    id: 'weather-swap-dry-free-outdoor',
    nudge: swap({
      candidateRef: { id: 'cand-3', title: 'Riverdale Farm drop-in', venueName: 'Riverdale Farm' },
      weatherFact: 'the forecast looks dry',
      whyFacts: ['free', 'outdoor'],
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Riverdale'], forbidden: ['rain', 'wet', 'indoor'] },
  },
  {
    id: 'weather-swap-no-venue',
    // venueName is null: naming a venue here would be a straight invention.
    nudge: swap({
      candidateRef: { id: 'cand-4', title: 'Neighbourhood skating drop-in', venueName: null },
      whyFacts: ['free', 'outdoor'],
      weatherFact: 'the forecast looks dry',
    }),
    gateAllowed: true,
    expect: { mustRecall: ['skating'] },
  },
  {
    id: 'weather-swap-unnamed-children',
    // The family's children were never named. No name may be invented for them.
    nudge: swap({ kidNames: [] }),
    gateAllowed: true,
    expect: { mustRecall: ['story time'] },
  },
  {
    id: 'weekday-dropin-named-venue',
    // VIL-360 · the weekday find. The row carries no clock time at all, so the DAY is
    // the only time-shaped fact and a stated hour is a straight invention.
    nudge: dropIn(),
    gateAllowed: true,
    expect: {
      mustRecall: ['EarlyON drop-in', 'Tuesday'],
      forbidden: ['saturday', 'sunday', 'forecast', 'am', 'a.m.'],
    },
  },
  {
    id: 'weekday-dropin-no-venue-no-names',
    // Neither a venue nor a named child. The message still has to read as a sentence
    // rather than reach for "the kids" or a place Hale never found.
    nudge: dropIn({
      candidateRef: { id: 'civic-2', title: 'Baby storytime', venueName: null },
      eventDate: '2026-08-05',
      weekday: 'wednesday',
      kidNames: [],
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Baby storytime', 'Wednesday'], forbidden: ['tuesday'] },
  },
  {
    id: 'weekday-dropin-friday',
    // A Friday session for two children, so the day and the names both have to land.
    nudge: dropIn({
      candidateRef: { id: 'civic-3', title: 'Family drop-in', venueName: 'Leaside Library' },
      eventDate: '2026-08-07',
      weekday: 'friday',
      kidNames: ['Mia', 'Leo'],
    }),
    gateAllowed: true,
    expect: { mustRecall: ['Family drop-in', 'Friday', 'Mia', 'Leo'], forbidden: ['weekend'] },
  },
  {
    id: 'nothing-worthy-never-composes',
    nudge: null,
    gateAllowed: true,
    expect: { neverComposes: true },
  },
  {
    id: 'post-stop-never-composes',
    // The family pressed STOP. There IS something worth saying and it must still not be
    // written, let alone sent.
    nudge: registration(),
    gateAllowed: false,
    expect: { neverComposes: true },
  },
];
