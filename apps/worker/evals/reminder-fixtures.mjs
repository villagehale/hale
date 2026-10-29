// The reminder — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/reminder.md): the model writes
// the WHOLE reminder from facts, in the parent's language. No fixed copy and no wording
// checks: a judge reads facts only (including AM/PM and language). Each fixture is the
// input to `reminderFacts` (apps/web/lib/loop/reminders/compose.ts), so the eval replays
// the exact facts production builds. Includes timed 'Jour de congé' and 'PD Day' events
// (the title names the day, the event still has a time), all-day events, and fr, zh and
// en parents.

const TZ = 'America/Toronto';
const SUN_6PM = '2026-10-25T22:00:00Z';
const PLAN = 'https://app.villagehale.com/plan';
const KID = { id: 'c-kid', name: 'Léa', dateOfBirth: '2019-04-02', gender: 'girl' };
// A fake second kid, for the two-kid next-day reminder (VIL-467). Never real family data.
const SIB = { id: 'c-sib', name: 'Theo', dateOfBirth: '2022-06-14', gender: 'boy' };
const TEEN = { id: 'c-teen', name: 'Rowan', dateOfBirth: '2011-03-01', gender: null };

function ev(over) {
  return { eventRef: 'e1', childId: null, sensitive: false, location: null, endsAt: null, ...over };
}

function args(over) {
  return {
    children: [],
    level: 'first_name',
    timeZone: TZ,
    offset: '-P1D',
    now: SUN_6PM,
    planLink: null,
    language: 'en',
    ...over,
  };
}

export const REMINDER_FIXTURES = [
  {
    id: 'fr-jour-de-conge-timed',
    args: args({
      language: 'fr',
      events: [
        ev({
          title: 'Jour de congé',
          startsAt: '2026-10-26T19:00:00Z',
          endsAt: '2026-10-26T20:00:00Z',
          location: 'Georgetown library, 9 Church St',
        }),
      ],
    }),
    watchFor:
      'The prod bug. The family\'s calendar has an event titled "Jour de congé" (day off) from 3:00 to 4:00 PM tomorrow at Georgetown library, 9 Church St: something they go to at that venue, not a closure, and the facts say nothing more about what it is. In French; states tomorrow, 15 h or 3 PM to 16 h or 4 PM (both times), the venue name and the street address. A missing start, end, venue or address is a LOW score. Saying the library is closed, guessing what the activity is, or calling the day free, quiet, a break or breathing room is a LOW score. Leaving the place name untranslated or quoting the title as-is is not a fault.',
  },
  {
    id: 'en-pd-day-timed',
    args: args({
      events: [
        ev({
          title: 'PD Day',
          startsAt: '2026-10-26T13:30:00Z',
          endsAt: '2026-10-26T16:00:00Z',
          location: 'Northside community centre',
        }),
      ],
    }),
    watchFor:
      'A timed PD Day program, 9:30 AM to 12:00 PM tomorrow at the community centre. 9:30 must be AM. It is something to be at, never a free day.',
  },
  {
    id: 'en-pd-day-all-day',
    args: args({
      events: [
        ev({ title: 'PD Day', startsAt: '2026-10-26T04:00:00Z', endsAt: '2026-10-27T04:00:00Z' }),
      ],
    }),
    watchFor:
      'An all-day PD Day tomorrow with no time. No clock time may appear. Saying it is a PD day is fine. The facts do not say school is closed or who it affects; stating that (or any other consequence of the title) as fact is an unstated inference and a LOW score, as is inventing plans or a time.',
  },
  {
    id: 'fr-all-day-plus-timed',
    args: args({
      language: 'fr',
      children: [KID],
      events: [
        ev({
          eventRef: 'e1',
          title: 'Jour de congé',
          startsAt: '2026-10-26T04:00:00Z',
          endsAt: '2026-10-27T04:00:00Z',
        }),
        ev({
          eventRef: 'e2',
          title: 'Natation',
          childId: 'c-kid',
          startsAt: '2026-10-26T14:00:00Z',
          endsAt: '2026-10-26T15:00:00Z',
          location: 'Piscine Main, 120 Main St',
        }),
      ],
    }),
    watchFor:
      'Tomorrow is an all-day Jour de congé AND Léa has swimming 10:00-11:00 AM at Piscine Main, 120 Main St. In French. Both must be there; the day must not be called free or empty, because a timed event exists. 10 h, not 22 h.',
  },
  {
    id: 'zh-hour-out',
    args: args({
      language: 'zh',
      offset: '-PT1H',
      now: '2026-10-26T22:00:00Z',
      events: [
        ev({
          title: 'Piano lesson',
          startsAt: '2026-10-26T23:00:00Z',
          endsAt: '2026-10-27T00:00:00Z',
          location: 'Ms. Chen studio',
        }),
      ],
    }),
    watchFor:
      'In Chinese. Piano lesson in about an hour, 7:00-8:00 PM (晚上7点 / 下午7点 style is fine; it must be evening, not morning). Place as given.',
  },
  {
    id: 'zh-evening-with-plan',
    args: args({
      language: 'zh',
      planLink: PLAN,
      events: [
        ev({
          eventRef: 'e1',
          title: 'Soccer',
          startsAt: '2026-10-26T21:30:00Z',
          endsAt: '2026-10-26T22:30:00Z',
          location: 'Riverside Field, 22 Park Rd',
        }),
        ev({
          eventRef: 'e2',
          title: 'Library story time',
          startsAt: '2026-10-26T15:00:00Z',
          endsAt: '2026-10-26T15:45:00Z',
          location: 'Georgetown library, 9 Church St',
        }),
      ],
    }),
    watchFor:
      'In Chinese. Two things tomorrow: story time 11:00-11:45 AM at Georgetown library, 9 Church St, and soccer 5:30-6:30 PM at Riverside Field, 22 Park Rd. Both with correct morning/afternoon, and each with its start, its end or duration, the venue name and the street address it was given. A missing start, end, venue or address is a LOW score. The plan link may appear once, exactly; no other link.',
  },
  {
    id: 'en-teen-generic',
    args: args({
      children: [TEEN],
      events: [
        ev({
          title: 'Therapy intake',
          childId: 'c-teen',
          startsAt: '2026-10-26T20:45:00Z',
          endsAt: '2026-10-26T21:45:00Z',
          location: '12 Clinic Rd',
        }),
      ],
    }),
    watchFor:
      "A 13+ child's private item, redacted to 'an appointment' with no place. The text must stay exactly that generic, give 4:45 PM, and not guess or remark on what it is.",
  },
  {
    id: 'en-late-same-day',
    args: args({
      now: '2026-10-26T11:00:00Z',
      events: [
        ev({
          title: 'Swim class',
          startsAt: '2026-10-26T14:00:00Z',
          endsAt: '2026-10-26T15:00:00Z',
        }),
      ],
    }),
    watchFor:
      "Sent at 7:00 AM on the event's own day. It is today, not tomorrow. 10:00 AM to 11:00 AM.",
  },
  {
    id: 'en-next-day-multi-event',
    args: args({
      children: [KID, SIB],
      events: [
        ev({
          eventRef: 'e1',
          childId: 'c-sib',
          title: 'Montessori tour',
          startsAt: '2026-10-26T14:00:00Z',
          endsAt: '2026-10-26T15:00:00Z',
          location: 'Little Oaks Montessori, 41 Mill St',
        }),
        ev({
          eventRef: 'e2',
          childId: 'c-kid',
          title: 'Storytime',
          startsAt: '2026-10-26T17:30:00Z',
          endsAt: '2026-10-26T18:15:00Z',
          location: 'Georgetown Branch, 9 Church St',
        }),
      ],
    }),
    watchFor:
      "Fake family, two kids, two events tomorrow (VIL-467). The reminder may be one text or several; read them in order as one message. FACTS GUARDRAIL, by meaning: across the texts, EVERY event keeps its start time, its end time or duration, and its specific venue name and address as given (Montessori tour 10 to 11 AM at Little Oaks Montessori, 41 Mill St; storytime 1:30 to 2:15 PM at Georgetown Branch, 9 Church St), so the parent never has to look anything up. Any event's time, end or place missing or vague is a LOW score. Sentence shape, a list, or leaving a place name as given is not a fault.",
  },
  {
    id: 'en-voice-not-template',
    args: args({
      children: [KID, SIB],
      events: [
        ev({
          eventRef: 'e1',
          childId: 'c-sib',
          title: 'Montessori tour',
          startsAt: '2026-10-26T14:00:00Z',
          endsAt: '2026-10-26T15:00:00Z',
          location: 'Little Oaks Montessori, 41 Mill St',
        }),
        ev({
          eventRef: 'e2',
          childId: 'c-kid',
          title: 'Toddler Storytime',
          startsAt: '2026-10-26T17:30:00Z',
          endsAt: '2026-10-26T18:00:00Z',
          location: 'Georgetown Branch, 9 Church St',
        }),
        ev({
          eventRef: 'e3',
          childId: 'c-kid',
          title: 'Swim',
          startsAt: '2026-10-26T21:00:00Z',
          endsAt: '2026-10-26T21:45:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
        }),
      ],
    }),
    watchFor:
      'Fake family (P0, Oct 28 prod text). VOICE CHECK: three events tomorrow. Every fact must be there (tour 10 to 11 AM at Little Oaks Montessori, 41 Mill St; storytime 1:30 to 2 PM at Georgetown Branch, 9 Church St; swim 5 to 5:45 PM at Mold-Masters SportsPlex, 221 Guelph St). Then judge by meaning whether it reads like a friend texting about tomorrow, or like the same frame ("X is at T1 to T2 at P") filled in three times. A filled-in frame scores at most 3 even with every fact right.',
  },
  {
    id: 'en-split-two-events',
    args: args({
      children: [KID],
      events: [
        ev({
          eventRef: 'e1',
          childId: 'c-kid',
          title: 'Parent & Tot Skate',
          startsAt: '2026-10-26T14:30:00Z',
          endsAt: '2026-10-26T15:20:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
        }),
        ev({
          eventRef: 'e2',
          childId: 'c-kid',
          title: 'Toddler Storytime',
          startsAt: '2026-10-26T17:30:00Z',
          endsAt: '2026-10-26T18:00:00Z',
          location: 'Georgetown Branch, 9 Church St',
        }),
      ],
    }),
    watchFor:
      'Fake family (P0, Oct 27 18:12 prod text that put two events in one long block). VOICE CHECK: two events tomorrow. Each must keep its start, end, venue name and address (skate 10:30 to 11:20 AM at Mold-Masters SportsPlex, 221 Guelph St; storytime 1:30 to 2 PM at Georgetown Branch, 9 Church St). Then judge by meaning whether they reach the parent as short texts a person takes in at a glance, rather than both packed into one long block. One long block holding both events scores at most 3 even with every fact right; how the texts are split is otherwise up to the writer.',
  },
  // VIL-474 · bold. Facts carry no "changed" signal, so in every case below the right
  // answer is no bold, or at most one fact the parent might act on. The judge's BOLD
  // CHECK reads the [bold] line on every fixture; these add routine shapes where bold
  // is easy to misuse.
  {
    id: 'en-bold-routine-single',
    args: args({
      children: [KID],
      events: [
        ev({
          childId: 'c-kid',
          title: 'Parent & Tot Skate',
          startsAt: '2026-10-26T14:30:00Z',
          endsAt: '2026-10-26T15:20:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
        }),
      ],
    }),
    watchFor:
      'Fake family. One routine event tomorrow: skate 10:30 to 11:20 AM at Mold-Masters SportsPlex, 221 Guelph St, for Léa. Every fact must be there. BOLD CHECK: nothing here stands out as a fact to act on, so no bold is expected; bold on anything that is not a single actionable fact scores at most 3.',
  },
  {
    id: 'fr-bold-hour-out',
    args: args({
      language: 'fr',
      offset: '-PT1H',
      now: '2026-10-26T20:00:00Z',
      events: [
        ev({
          title: 'Natation',
          startsAt: '2026-10-26T21:00:00Z',
          endsAt: '2026-10-26T21:45:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
        }),
      ],
    }),
    watchFor:
      "Fake family, in French. Swim in about an hour, 17 h to 17 h 45, at Mold-Masters SportsPlex, 221 Guelph St. Every fact must be there. BOLD CHECK: a routine hour-out reminder; no bold is expected, and bold on the title, the greeting or the whole text scores at most 3.",
  },
  {
    id: 'en-bold-three-events',
    args: args({
      children: [KID, SIB],
      events: [
        ev({
          eventRef: 'e1',
          childId: 'c-sib',
          title: 'Swim',
          startsAt: '2026-10-26T13:00:00Z',
          endsAt: '2026-10-26T13:45:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
        }),
        ev({
          eventRef: 'e2',
          childId: 'c-kid',
          title: 'Dentist',
          startsAt: '2026-10-26T15:00:00Z',
          location: 'Bright Smiles Dental, 12 Main St',
        }),
        ev({
          eventRef: 'e3',
          childId: 'c-kid',
          title: 'Piano',
          startsAt: '2026-10-26T21:00:00Z',
          endsAt: '2026-10-26T21:30:00Z',
          location: 'Halton Music, 5 Queen St',
        }),
      ],
    }),
    watchFor:
      'Fake family, two kids, three events tomorrow: Theo swim 9 to 9:45 AM at Mold-Masters SportsPlex, 221 Guelph St; Léa dentist 11 AM at Bright Smiles Dental, 12 Main St (no end given); Léa piano 5 to 5:30 PM at Halton Music, 5 Queen St. Every fact must be there; inventing an end for the dentist is a LOW score. BOLD CHECK: at most one thing; bolding several facts or a whole text scores at most 3. No bold is fine.',
  },
  // VIL-474 · bold clearly right: the provider moved the time / changed the venue, so the
  // `changed` fact is set from source data and the new value is the fact to act on.
  {
    id: 'en-bold-moved-time',
    args: args({
      children: [KID],
      events: [
        ev({
          childId: 'c-kid',
          title: 'Swim',
          startsAt: '2026-10-26T20:30:00Z',
          endsAt: '2026-10-26T21:15:00Z',
          location: 'Mold-Masters SportsPlex, 221 Guelph St',
          change: { field: 'time', previousStartsAt: new Date('2026-10-26T21:00:00Z') },
        }),
      ],
    }),
    watchFor:
      'Fake family. Léa swim tomorrow, MOVED from 5 PM to 4:30 PM (until 5:15 PM) at Mold-Masters SportsPlex, 221 Guelph St. CHANGED FACT: the text must give the new time 4:30 PM and make clear it changed. BOLD CHECK: bold on the new time is right; no bold at all scores at most 3; bold on anything else scores at most 3.',
  },
  {
    id: 'fr-bold-changed-venue',
    args: args({
      language: 'fr',
      events: [
        ev({
          title: 'Natation',
          startsAt: '2026-10-26T21:00:00Z',
          endsAt: '2026-10-26T21:45:00Z',
          location: 'Piscine Centennial, 5 Lake Rd',
          change: { field: 'venue', previousLocation: 'Mold-Masters SportsPlex, 221 Guelph St' },
        }),
      ],
    }),
    watchFor:
      "Fake family, in French. Swim tomorrow 17 h to 17 h 45; the VENUE CHANGED from Mold-Masters SportsPlex, 221 Guelph St to Piscine Centennial, 5 Lake Rd. CHANGED FACT: the text must give the new venue name and address and make clear it changed. BOLD CHECK: bold on the new venue is right; no bold at all scores at most 3; bold on anything else scores at most 3.",
  },
];
