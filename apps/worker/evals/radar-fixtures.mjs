// VIL-238 · M3 radar COMPOSE fixtures.
//
// Each fixture is a DECISION OBJECT — exactly what the deterministic DECIDE cascade
// emits and the only thing the composer ever sees. The corpus spans the four axes the
// M3 brief names, because each one changes what an honest message may say:
//
//   family size      1 / 2 / 3 kids   (multi-kid discipline: ONE message, one pick)
//   registration     present / absent / BETWEEN CYCLES
//                    (absent → said lightly, not implied; between cycles → the town has
//                     opened before and its next dates are not posted, which is a
//                     different sentence and the one the 2026-09-16 defect could not say)
//   weather          good / bad / unavailable
//                    (good → the pick may claim a dry forecast; bad → the decision
//                     already chose indoors and there is NO weather fact to state;
//                     unavailable → an outdoor pick with no weather claim at all)
//   village data     rich / thin      (thin → no pick exists, and none may be invented)
//   checkpoint       present / absent (the age block: an Ontario health-ADMIN window,
//                                      the one rung that survives an empty geography)
//
// ATTRIBUTION is scored across the whole corpus rather than fixture by fixture, because
// it is a property of every message that carries a find and there is nothing per-fixture
// to say about it. The runner derives who is exempt — `1kid-nothing-at-all`, the one
// decision with all three rungs null, whose mapping line already IS the look — so a new
// all-null fixture is exempted by its own shape and never by remembering to flag it.
//
// `expect.mustRecall` tokens are derived from the DECISION, never from model output:
// a message that drops the one fact it exists to deliver has failed regardless of how
// nice it reads. `expect.orderedRecall` is the same, plus the CASCADE: the tokens must
// appear in the order given, which is how "registration leads" is checked without
// asking a judge for an opinion.

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

/** A registration silence with a reason in it: this town's last cycle has already gone.
 * Mirrors RegistrationAbsence in apps/web/lib/channel/intake/radar-decide.ts. */
function absence(over = {}) {
  return {
    cycleRef: { municipality: 'toronto', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
    lastOpenedAtLocal: 'Sep 8, 7:00 a.m.',
    nextCycleLabel: null,
    ...over,
  };
}

/** Rows lifted VERBATIM from the reviewed Ontario table (apps/web/lib/health/
 * checkpoints.ts). No wording is invented here — a fixture that softened a task would
 * be testing copy no family will ever receive. */
const CHECKPOINT_18_MONTH_SCHEDULE = "Ontario's routine vaccine schedule has a visit at 18 months.";
const CHECKPOINT_18_MONTH_WELL_BABY =
  'Ontario runs a longer 18-month well-baby visit with your family doctor.';
const CHECKPOINT_TEEN_RECORDS = 'A routine vaccine record check is due between ages 14 and 16.';

function checkpoint(id, task, kidNames) {
  return { checkpointRef: { id }, task, kidNames };
}

function decision(weekendPick, registrationLine, checkpointLine = null, registrationAbsence = null) {
  return {
    weekendPick,
    registrationLine,
    registrationAbsence,
    checkpoint: checkpointLine,
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
    // All three rungs empty — the only shape left with nothing true to say. It maps,
    // and it says when the first find lands. It does not shrug.
    decision: decision(null, null),
    expect: {
      mustRecall: ['Your first weekend find lands in a day or two.'],
      forbidden: ['drop-in', 'library', 'swim', 'registration opens'],
    },
  },
  {
    id: '1kid-between-cycles-toronto-pick-present',
    // THE PRODUCTION CASE (2026-09-16). Toronto's fall cycle opened on Sep 8 and the
    // next dates are not published. This family got "No registration dates on my radar
    // yet" — which is what a family in an uncovered town gets, and their own town was
    // never named. The message must say the reason, and must not promise a future text:
    // the watch offer the shell appends is where the offer lives.
    decision: decision(pick(), null, null, absence()),
    expect: {
      mustRecall: ['Riverdale', 'Toronto', 'Sep 8'],
      forbidden: ['radar yet', 'http', 'Winter', 'Spring', "I'll text", 'let you know'],
    },
  },
  {
    id: '1kid-between-cycles-halton-hills-next-cycle-named',
    // No pick, no checkpoint: the absence IS the message, next to the first-find beat.
    // Halton Hills opened Fall 2026 on Sep 1 and the sweep is watching for Winter 2027,
    // so the cycle Hale is waiting on can be named for once.
    decision: decision(null, null, null, absence({
      cycleRef: { municipality: 'halton_hills', programDomain: 'rec_program', cycleLabel: 'Fall 2026' },
      lastOpenedAtLocal: 'Sep 1, 7:00 a.m.',
      nextCycleLabel: 'Winter 2027',
    })),
    expect: {
      mustRecall: ['Halton Hills', 'Fall 2026', 'Sep 1', 'Winter 2027'],
      forbidden: ['radar yet', 'http', "I'll text", 'let you know', 'opens'],
    },
  },
  {
    id: 'checkpoint-only-18mo-halton-hills',
    // The live-gate family: outside civic-adapter coverage, no registration windows,
    // nothing discovered yet. Geography is empty; the child is 18 months old.
    decision: decision(null, null, checkpoint('immunization_18_months', CHECKPOINT_18_MONTH_SCHEDULE, ['Maya'])),
    expect: {
      mustRecall: ['18 months'],
      // Every specific a helpful-sounding model would reach for and does not have.
      forbidden: ['clinic', 'book', 'appointment', 'weeks', 'due for', 'behind', 'should'],
    },
  },
  {
    id: 'checkpoint-only-unnamed-child',
    // The parent described a baby without naming one. No name, and no "your little one
    // is due" — the window belongs to the calendar, not to the child.
    decision: decision(null, null, checkpoint('well_baby_18_months', CHECKPOINT_18_MONTH_WELL_BABY, [])),
    expect: {
      mustRecall: ['18-month'],
      forbidden: ['due', 'behind', 'overdue', 'on track', 'make sure'],
    },
  },
  {
    id: 'checkpoint-teen-household-generic-wording',
    // Every child in this household is 13+, so the row arrives in its GENERIC wording
    // with no name attached (rule #1). The composer may not put one back.
    decision: decision(null, null, checkpoint('immunization_14_to_16_years', CHECKPOINT_TEEN_RECORDS, [])),
    expect: {
      mustRecall: ['record check'],
      forbidden: ['vaccine record for', 'your teen is', 'behind', 'shots'],
    },
  },
  {
    id: 'registration-and-checkpoint-precedence',
    // Both rungs filled and no pick between them: the date that closes leads, the
    // administrative window that stays open for months follows.
    decision: decision(
      null,
      registration(),
      checkpoint('immunization_18_months', CHECKPOINT_18_MONTH_SCHEDULE, ['Maya']),
    ),
    expect: { orderedRecall: ['6:30', '18 months'] },
  },
  {
    id: 'checkpoint-fabrication-trap',
    // A task that NAMES a visit and carries no lead time, no date and no place. A
    // booking window is the plausible detail a parent would act on and find wrong, so
    // it is the one this fixture exists to catch.
    decision: decision(null, null, checkpoint('well_baby_18_months', CHECKPOINT_18_MONTH_WELL_BABY, ['Noor'])),
    expect: {
      mustRecall: ['well-baby'],
      forbidden: [
        'weeks ahead',
        'in advance',
        'wait',
        'fill up',
        'fills up',
        'book it',
        'call your',
        'usually takes',
      ],
    },
  },
  {
    id: 'all-three-blocks-ceiling-holds',
    // Maximum pressure on the 3-sentence, 2-segment ceiling. The two leads must
    // survive; the checkpoint is the block that gives way if anything must.
    decision: decision(
      pick({ whyFacts: ['free', 'outdoor'] }),
      registration(),
      checkpoint('immunization_18_months', CHECKPOINT_18_MONTH_SCHEDULE, ['Maya']),
    ),
    expect: { orderedRecall: ['6:30', 'Riverdale'] },
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
