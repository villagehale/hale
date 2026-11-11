/**
 * VIL-643 — a parent's own words withdraw calendar use only.
 *
 * These fixtures run against the common-time group reader
 * (`shared-group-reading-common-time`). Record once, then `--cached-only`.
 * Not in CI until that recording exists.
 */
export const SHARED_GROUP_CALENDAR_WITHDRAW_FIXTURES = [
  {
    id: 'en-stop-checking-my-calendar',
    accept: ['withdraw_calendar'],
    input: {
      text: 'Hale, stop checking my calendar',
      reaction: null,
      language: 'en',
      people: [{ firstName: 'Ada', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'fr-stop-checking-my-calendar',
    accept: ['withdraw_calendar'],
    input: {
      text: 'Hale, arrête de consulter mon calendrier',
      reaction: null,
      language: 'fr',
      people: [{ firstName: 'Camille', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
  {
    id: 'en-leave-me-out-is-still-stop',
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
    id: 'fr-stop-writing-is-still-stop',
    accept: ['stop_me'],
    input: {
      text: 'Hale, ne m écris plus ici',
      reaction: null,
      language: 'fr',
      people: [{ firstName: 'Jordan', knownCustomer: true, familyLinked: true }],
      recent: [],
    },
  },
];
