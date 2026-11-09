/**
 * VIL-456 — inference and opt-out. Judges score meaning, not wording.
 * VIL-459 — a find-time ask. `covers` are instants the chat ruled out (some span must
 * hold each); `open` are instants nobody ruled out (no span may hold them).
 */
export const SHARED_GROUP_READING_FIXTURES = [
  {
    id: 'first-ask-no-setup',
    accept: ['question'],
    input: {
      text: 'Hale, can you keep track of who is coming to Saturday swim?',
      reaction: null,
      language: 'en',
      people: [
        { firstName: 'Mei', knownCustomer: true, familyLinked: true },
        { firstName: 'Ada', knownCustomer: true, familyLinked: true },
      ],
      recent: [],
    },
  },
  {
    id: 'banter-stays-quiet',
    accept: ['chatter'],
    input: {
      text: 'I can bring orange slices',
      reaction: null,
      language: 'en',
      people: [{ firstName: 'Tom', knownCustomer: true, familyLinked: true }],
      recent: [{ from: 'member', text: 'Hale, Saturday swim?' }],
    },
  },
  {
    id: 'who-i-am-any-wording',
    accept: ['who_i_am'],
    input: {
      text: 'hey I am Ada, Leo is my kid',
      reaction: null,
      language: 'en',
      people: [{ firstName: null, knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'leave-me-out',
    accept: ['stop_me'],
    input: {
      text: 'Hale, leave me out of this one',
      reaction: null,
      language: 'en',
      people: [{ firstName: 'Jordan', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'stop-in-french',
    accept: ['stop_me'],
    input: {
      text: 'Hale, ne m écris plus ici',
      reaction: null,
      language: 'fr',
      people: [{ firstName: 'Jordan', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'heart-is-yes',
    accept: ['yes'],
    input: {
      text: '',
      reaction: 'yes',
      language: 'en',
      people: [{ firstName: 'Priya', knownCustomer: true, familyLinked: true }],
      recent: [{ from: 'hale', text: 'who is in for Saturday swim' }],
    },
  },
  {
    id: 'family-leaving',
    accept: ['leave'],
    input: {
      text: 'we are out of the carpool this season',
      reaction: null,
      language: 'en',
      people: [{ firstName: 'Priya', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'find-time-not-saturday-morning',
    accept: ['find_time'],
    covers: ['2026-10-31T10:00:00-04:00'],
    open: ['2026-10-31T15:00:00-04:00', '2026-10-29T18:00:00-04:00'],
    input: {
      text: "Hale, when can all three families do the zoo? Saturday morning doesn't work for us",
      reaction: null,
      language: 'en',
      people: [
        { firstName: 'Mei', knownCustomer: true, familyLinked: true },
        { firstName: 'Ada', knownCustomer: true, familyLinked: true },
        { firstName: 'Priya', knownCustomer: true, familyLinked: true },
      ],
      recent: [],
      clock: { now: '2026-10-28T11:00:00-04:00', timeZone: 'America/New_York' },
    },
  },
  {
    id: 'find-time-spanish-tuesday-out',
    accept: ['find_time'],
    covers: ['2026-11-03T12:00:00-06:00'],
    open: ['2026-11-04T12:00:00-06:00'],
    input: {
      text: 'Hale, ¿qué día nos viene bien a todos para ir al parque? El martes no podemos.',
      reaction: null,
      language: 'es',
      people: [
        { firstName: 'Lucía', knownCustomer: true, familyLinked: true },
        { firstName: 'Ana', knownCustomer: true, familyLinked: true },
      ],
      recent: [],
      clock: { now: '2026-10-28T10:00:00-05:00', timeZone: 'America/Chicago' },
    },
  },
  {
    id: 'find-time-answer-to-proposal',
    accept: ['find_time'],
    covers: ['2026-10-31T12:00:00-04:00'],
    open: ['2026-11-01T10:00:00-05:00'],
    input: {
      text: "Saturday's no good for us, Sunday works",
      reaction: null,
      language: 'en',
      people: [
        { firstName: 'Mei', knownCustomer: true, familyLinked: true },
        { firstName: 'Priya', knownCustomer: true, familyLinked: true },
      ],
      recent: [
        { from: 'member', text: 'Hale, when can all three families do the zoo?' },
        {
          from: 'hale',
          text: "I checked Mei's and Ada's calendars: Thu 7pm, Sat 8am or Sun 8am could work. Priya, do any of these work for you?",
        },
      ],
      clock: { now: '2026-10-28T11:00:00-04:00', timeZone: 'America/New_York' },
    },
  },
  {
    id: 'opening-hours-is-a-question',
    accept: ['question'],
    input: {
      text: 'Hale, what time does the zoo open on Saturday?',
      reaction: null,
      language: 'en',
      people: [{ firstName: 'Mei', knownCustomer: true, familyLinked: true }],
      recent: [],
      clock: { now: '2026-10-28T11:00:00-04:00', timeZone: 'America/New_York' },
    },
  },
];
