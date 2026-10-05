// VIL-239 · M4 proactive-nudge COMPOSE fixtures, after VIL-413 / VIL-417.
//
// Each fixture is the FACTS of one find — exactly what `nudgeVoiceContext` reduces the
// selector's decision to, and the only thing the composer ever sees — plus the language
// and register the sweep would speak it in. `nudgeLineInput` (loaded live from
// apps/web/lib/channel/nudge/nudge-line-input.ts) turns it into what the model sees, so a
// change to the facts a kind hands over re-keys the cache here.
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
//   language      English tu / French tu / French vous (the household group)
//
// `forbidden` is the old fabrication gate, kept: words that would mean the model reached
// past its facts (rain on a cold forecast, a weekend on a weekday find). Checked outside
// the fact slots, lower-cased.
//
// The two "never composes" cases the corpus used to carry (nothing worth saying; a family
// that pressed STOP) are plumbing invariants — compose is downstream of the gate and a
// non-null decision — and live in apps/web/lib/channel/nudge/run.test.ts, where no model
// runs. They are not model tests and no longer sit here.

/** The opt-out sentence a composer must never write. Mirrors NUDGE_OPT_OUT in nudge-voice.ts. */
export const NUDGE_OPT_OUT = 'Reply STOP to opt out.';

function registration(over = {}) {
  return {
    kind: 'registration',
    town: 'Richmond Hill',
    cycle: 'Fall 2026',
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
    what: 'Central Library story time',
    where: 'Toronto Public Library',
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
    what: 'EarlyON drop-in',
    where: 'Armour Heights',
    day: 'tuesday',
    kidNames: ['Mia'],
    ...over,
  };
}

export const NUDGE_FIXTURES = [
  {
    id: '1kid-window-soon',
    language: 'en',
    address: 'tu',
    facts: registration(),
    forbidden: ['weekend', 'forecast'],
    watchFor:
      'A registration deadline: the town, the cycle, when it opens (reuse "Aug 5, 10:30 a.m." as given or omit the time), and that it is for Maya. One or two sentences. No urgency Hale was not given, no advice, no reminder offer, no question.',
  },
  {
    id: '2kid-window-soon-resident-head-start',
    language: 'en',
    address: 'tu',
    facts: registration({
      kidNames: ['Maya', 'Leo'],
      residentNote: 'residents can register first',
    }),
    forbidden: ['weekend', 'forecast'],
    watchFor:
      'Names Maya and Leo naturally in the line. Carries the resident head start in its own words. No question, no "set a reminder".',
  },
  {
    id: '3kid-window-soon-approximate-age',
    language: 'en',
    address: 'tu',
    facts: registration({
      town: 'Markham',
      cycle: 'Winter 2027',
      kidNames: ['Maya', 'Leo', 'Sam'],
      ageApproximate: true,
    }),
    forbidden: ['forecast'],
    watchFor:
      'Three kids, ONE message. The age match rests on a guess, so the line hedges the KIDS ("if they are still in that band"), never the date. Must not assert the age band.',
  },
  {
    id: 'weather-swap-wet-indoor',
    language: 'en',
    address: 'tu',
    facts: swap({ kidNames: ['Maya', 'Leo'] }),
    forbidden: ['sunny', 'dry', 'cold'],
    watchFor:
      'Wet forecast is the PREMISE: lead with the weather, then the thing it points to. Uses "Central Library story time" as given. At most one reason (free or indoor) in its own words. No time of day. No second day.',
  },
  {
    id: 'weather-swap-cold-indoor',
    language: 'en',
    address: 'tu',
    facts: swap({
      what: 'Family swim',
      where: 'Angus Glen Community Centre',
      day: 'sunday',
      weatherFact: 'the weekend forecast is cold',
      whyFacts: ['paid ($$)', 'indoor'],
    }),
    forbidden: ['rain', 'wet', 'free'],
    watchFor:
      'COLD, not wet. Saying rain here is a fabrication with a correct conclusion. Must not call it free. Sunday only.',
  },
  {
    id: 'weather-swap-dry-free-outdoor',
    language: 'en',
    address: 'tu',
    facts: swap({
      what: 'Riverdale Farm drop-in',
      where: 'Riverdale Farm',
      weatherFact: 'the forecast looks dry',
      whyFacts: ['free', 'outdoor'],
    }),
    forbidden: ['rain', 'wet', 'indoor'],
    watchFor:
      'Dry forecast is the good news: lead with the day and the thing, let the forecast close the sentence. "Dry" is not "sunny". Does not write "at Riverdale Farm at Riverdale Farm".',
  },
  {
    id: 'weather-swap-no-venue',
    language: 'en',
    address: 'tu',
    facts: swap({
      what: 'Neighbourhood skating drop-in',
      where: null,
      whyFacts: ['free', 'outdoor'],
      weatherFact: 'the forecast looks dry',
    }),
    forbidden: [],
    watchFor:
      'venueName is null: naming a venue is a straight invention. Uses "Neighbourhood skating drop-in" as given, not "an outdoor skate".',
  },
  {
    id: 'weather-swap-unnamed-children',
    language: 'en',
    address: 'tu',
    facts: swap({ kidNames: [] }),
    forbidden: [],
    watchFor:
      'The children were never named. No name may be invented, and the sentence must still read without reaching for "the kids" or "you" to patch it.',
  },
  {
    id: 'weekday-dropin-named-venue',
    language: 'en',
    address: 'tu',
    facts: dropIn(),
    forbidden: ['saturday', 'sunday', 'forecast', ' am', 'a.m.', 'p.m.'],
    watchFor:
      'The weekday find. The row carries no clock time, so the DAY is the only time-shaped fact and a stated hour is an invention. Tuesday singular ("on Tuesday", never "Tuesdays"). Nothing expires, so no urgency.',
  },
  {
    id: 'weekday-dropin-no-venue-no-names',
    language: 'en',
    address: 'tu',
    facts: dropIn({ what: 'Baby storytime', where: null, day: 'wednesday', kidNames: [] }),
    forbidden: ['tuesday'],
    watchFor:
      'Neither a venue nor a named child. Reads as a sentence without "the kids" or a place Hale never found. Wednesday only.',
  },
  {
    id: 'weekday-dropin-friday',
    language: 'en',
    address: 'tu',
    facts: dropIn({
      what: 'Family drop-in',
      where: 'Leaside Library',
      day: 'friday',
      kidNames: ['Mia', 'Leo'],
    }),
    forbidden: ['weekend'],
    watchFor: 'A Friday session for two children: the day and both names land. No time of day.',
  },
  {
    id: 'registration-fr-tu',
    language: 'fr',
    address: 'tu',
    facts: registration({ kidNames: ['Léo'] }),
    forbidden: ['forecast', 'weekend'],
    watchFor:
      'French, tu, real accents. The town, the cycle, when it opens (reuse the given time or omit it), for Léo. No question. Never vous.',
  },
  {
    id: 'weather-swap-fr-vous',
    language: 'fr',
    address: 'vous',
    facts: swap({ kidNames: ['Maya', 'Léo'] }),
    forbidden: ['sunny', 'sec', 'froid'],
    watchFor:
      'Lands in the household group: vous, both parents reading, real accents. Wet forecast leads; "Central Library story time" as given; samedi. No time of day, no second day.',
  },
  {
    id: 'weekday-dropin-fr-tu',
    language: 'fr',
    address: 'tu',
    facts: dropIn({ kidNames: ['Mia'] }),
    forbidden: ['samedi', 'dimanche', 'tuesday'],
    watchFor:
      'French, tu. "EarlyON drop-in" as given, mardi singular, for Mia, at Armour Heights. No hour. Nothing urgent.',
  },
];
