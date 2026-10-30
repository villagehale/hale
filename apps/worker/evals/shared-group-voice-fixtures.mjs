/** VIL-456 — model-written shared-group lines. Judges score meaning 1-5. */
export const SHARED_GROUP_VOICE_FIXTURES = [
  {
    id: 'intro-en',
    request: { kind: 'intro', adderFirstName: 'Mei' },
    language: 'en',
    watchFor: 'who Hale is, ask each person who they are, one question, no roles list',
  },
  {
    id: 'who-confirmed-en',
    request: {
      kind: 'who_confirmed',
      name: 'Ada',
      roleWord: 'mom',
      kidFirstName: 'Leo',
    },
    language: 'en',
    parentWords: 'I am Ada, Leo is my kid',
    watchFor: 'thanks Ada as Leo mom, no question, nothing she did not say',
  },
  {
    id: 'answer-from-thread',
    request: { kind: 'answer', lookup: null },
    language: 'en',
    parentWords: 'what time was swim again',
    threadSaid: [{ speaker: 'Mei', text: 'Saturday swim at 9:30 at the pool' }],
    watchFor: 'answers from the thread only, no calendar invention, no private names',
  },
  {
    id: 'member-stop',
    request: { kind: 'member_stop', name: 'Jordan' },
    language: 'en',
    parentWords: 'Hale, leave me out of this one',
    watchFor: 'Jordan only is left out, others keep Hale, no keyword to undo',
  },
  {
    id: 'intro-fr',
    request: { kind: 'intro', adderFirstName: 'Mei' },
    language: 'fr',
    watchFor: 'French vous, real accents, one question, no tu',
  },
];
