// The reminder — the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/reminder.md): the model writes
// the WHOLE reminder from facts, in the parent's language. No fixed copy and no wording
// checks: a judge reads facts, AM/PM, language and tone. Each fixture is the input to
// `reminderFacts` (apps/web/lib/loop/reminders/compose.ts), so the eval replays the exact
// facts production builds. Includes timed 'Jour de congé' and 'PD Day' events (the title
// names the day, the event still has a time), all-day events, and fr, zh and en parents.

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
          location: 'Georgetown library',
        }),
      ],
    }),
    watchFor:
      'The prod bug. The title says day off, but this is a timed 3:00-4:00 PM thing at the library tomorrow. In French; states tomorrow, 15 h or 3 PM to 16 h or 4 PM, and the place. Calling the day free, quiet, a break or breathing room is a LOW score.',
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
      'An all-day PD Day tomorrow with no time. No clock time may appear. Saying school is out or it is a PD day is fine; inventing plans or a time is not.',
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
          location: 'Piscine Main',
        }),
      ],
    }),
    watchFor:
      'Tomorrow is an all-day Jour de congé AND Léa has swimming 10:00-11:00 AM at Piscine Main. In French. Both must be there; the day must not be called free or empty, because a timed event exists. 10 h, not 22 h.',
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
        }),
        ev({
          eventRef: 'e2',
          title: 'Library story time',
          startsAt: '2026-10-26T15:00:00Z',
          endsAt: null,
        }),
      ],
    }),
    watchFor:
      'In Chinese. Two things tomorrow: story time at 11:00 AM and soccer 5:30-6:30 PM. Both with correct morning/afternoon. The plan link may appear once, exactly; no other link.',
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
      "Fake family, two kids, two events tomorrow (VIL-467). The prod miss read like a filled-in template: a stiff list of events with times and places, not a friend texting. The reminder may be one text or several; read them in order as one message. FACTS GUARDRAIL, by meaning: across the texts, EVERY event keeps its start time, its end time or duration, and its specific venue name and address as given (Montessori tour 10 to 11 AM at Little Oaks Montessori, 41 Mill St; storytime 1:30 to 2:15 PM at Georgetown Branch, 9 Church St), so the parent never has to look anything up. Any event's time, end or place missing or vague is a LOW score. A list-like, calendar-export feel is also a LOW score.",
  },
];
