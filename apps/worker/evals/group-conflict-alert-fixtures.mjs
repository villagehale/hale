// VIL-444 (T24) group clash alert fixtures. Fake families only.
//
// Each fixture is what Hale may read for one household: calendar rows as
// parent_calendar_blocks keeps them (a null title is a non-kid block, kept as busy time),
// Hale-held plans from family_events, and who is in the group chat. The runner turns them
// into the planner's input with the real code (group-conflict.ts), so a fixture never
// states the clash; it states the calendars.
//
// `expect` is the planner's answer: no alert, or the alert's shape (what the second item
// is, who is suggested, who may be asked). `mustNotLeak` lists private words that must not
// reach the model or the group. `watchFor` is for the judge only.

const TORONTO = 'America/Toronto';
const barton = { id: 'barton', name: 'Barton', calendar: true };
const sam = { id: 'sam', name: 'Sam', calendar: true };

const twoPickups = [
  {
    owner: 'barton',
    eventId: 'swim',
    title: 'Maya swim pickup',
    start: '2026-09-25T19:00:00.000Z',
    end: '2026-09-25T19:30:00.000Z',
  },
  {
    owner: 'barton',
    eventId: 'daycare',
    title: 'Leo daycare pickup',
    start: '2026-09-25T19:00:00.000Z',
    end: '2026-09-25T19:30:00.000Z',
  },
];

export const GROUP_CONFLICT_ALERT_FIXTURES = [
  {
    id: 'en-two-pickups-sam-free',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    expect: { second: 'plan', suggested: 'Sam', busy: [], couldAsk: [] },
    watchFor:
      "Both pickups are Friday at 3 and both are Barton's. Sam is free then on their calendar, so the fix is Sam taking Maya's swim pickup.",
  },
  {
    id: 'en-private-busy',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya'],
    people: [barton, sam],
    blocks: [
      twoPickups[0],
      {
        owner: 'barton',
        eventId: 'placed-allergist',
        title: 'Maya allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
      },
    ],
    events: [
      {
        id: 'allergist',
        title: 'Maya allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
        private: true,
        owner: { kind: 'parent', userId: 'barton' },
        placedGoogleEventId: 'placed-allergist',
      },
    ],
    expect: { second: 'busy', suggested: 'Sam', busy: ['Barton'], couldAsk: [] },
    mustNotLeak: ['allergist'],
    watchFor:
      "Barton is busy then with something private: it may only be called busy (or tied up), never what it is, never that it is hidden, never its own times. Sam is free on their calendar, so the fix is Sam taking Maya's swim pickup on Friday at 3.",
  },
  {
    id: 'fr-practice-onto-recital',
    language: 'fr',
    timeZone: TORONTO,
    now: '2026-10-01T14:00:00.000Z',
    kids: ['Léa', 'Chloé'],
    people: [
      { id: 'emilie', name: 'Émilie', calendar: true },
      { id: 'julien', name: 'Julien', calendar: false },
      { id: 'mamie', name: 'Mamie', calendar: false },
    ],
    blocks: [
      {
        owner: 'emilie',
        eventId: 'recital',
        title: 'Récital de piano de Léa',
        start: '2026-10-02T22:00:00.000Z',
        end: '2026-10-02T23:30:00.000Z',
      },
      {
        owner: 'emilie',
        eventId: 'soccer',
        title: 'Entraînement de soccer de Chloé',
        start: '2026-10-02T22:00:00.000Z',
        end: '2026-10-02T23:00:00.000Z',
      },
    ],
    events: [],
    expect: { second: 'plan', suggested: null, busy: [], couldAsk: ['Julien', 'Mamie'] },
    watchFor:
      "Chloé's soccer practice now falls on Léa's piano recital, Friday at 18:00, and Émilie has both. Nobody is free on a calendar Hale can see: it should say so and ask Julien or Mamie whether one of them can take one, without calling either of them free. French, vous.",
  },
  {
    id: 'en-same-kid',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya'],
    people: [barton, sam],
    blocks: [
      twoPickups[0],
      {
        owner: 'barton',
        eventId: 'dentist',
        title: 'Maya dentist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T19:45:00.000Z',
      },
    ],
    events: [],
    expect: { second: 'plan', suggested: 'Sam', busy: [], couldAsk: [] },
    watchFor:
      "Both items are Maya's, Friday at 3: a second driver does not fix that, because Maya cannot be in two places. It should say Maya is double-booked and ask which one she is going to, not hand Sam one of them.",
  },
  {
    id: 'en-recital-practice-covered',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: [
      {
        owner: 'barton',
        eventId: 'recital',
        title: 'Maya recital',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
      },
      {
        owner: 'sam',
        eventId: 'practice',
        title: 'Leo practice',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T19:30:00.000Z',
      },
    ],
    events: [],
    expect: null,
  },
  {
    id: 'en-no-repeat',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    alreadySentAt: '2026-09-25T17:30:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    expect: null,
  },
  {
    id: 'en-container',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T11:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: [
      {
        owner: 'barton',
        eventId: 'school',
        title: 'Maya school',
        start: '2026-09-25T12:30:00.000Z',
        end: '2026-09-25T19:30:00.000Z',
      },
      twoPickups[1],
    ],
    events: [],
    expect: null,
  },
];
