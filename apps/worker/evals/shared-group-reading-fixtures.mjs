/** VIL-456 — inference and opt-out. Judges score meaning, not wording. */
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
];
