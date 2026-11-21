// VIL-744 · the way out with NO_STOP_KEYWORD_COPY_ENABLED on: the group onboarding lines that
// carry it, and the coach answering someone who doubts Hale. No real names or numbers.

const CONNECT = { kind: 'connect_link_1to1', providers: ['Google Calendar', 'Gmail'] };

export const GROUP_WAY_OUT_FIXTURES = [
  {
    id: 'connect-en-named',
    request: { ...CONNECT, name: 'Sam', knownParentName: 'Riley' },
    language: 'en',
    saysWayOut: true,
  },
  {
    id: 'connect-en-unnamed',
    request: { ...CONNECT, name: null, knownParentName: null },
    language: 'en',
    saysWayOut: true,
  },
  {
    id: 'connect-fr-named',
    request: { ...CONNECT, name: 'Camille', knownParentName: 'Noor' },
    language: 'fr',
    saysWayOut: true,
  },
  {
    id: 'welcome-en',
    request: { kind: 'member_welcome', adderName: 'Maya' },
    language: 'en',
    saysWayOut: true,
  },
  {
    id: 'welcome-fr',
    request: { kind: 'member_welcome', adderName: 'Camille' },
    language: 'fr',
    saysWayOut: true,
  },
  {
    id: 'stop-ack-en',
    request: { kind: 'stop_ack' },
    language: 'en',
    parentWords: 'STOP',
    saysWayOut: false,
  },
  {
    id: 'stop-ack-fr',
    request: { kind: 'stop_ack' },
    language: 'fr',
    parentWords: 'ARRET',
    saysWayOut: false,
  },
];

export const COACH_DOUBT_FIXTURES = [
  { id: 'doubt-real-person', language: 'en', text: 'wait is this a real person' },
  { id: 'doubt-scam', language: 'en', text: 'is this a scam? who is behind this number' },
  { id: 'doubt-bot', language: 'en', text: 'are you a bot or what' },
  { id: 'doubt-fr', language: 'fr', text: 'c’est une arnaque? qui est derrière ce numéro' },
];

/** The word for stopping in prose, in the fixture's language. A keyword is refused apart. */
export function saysStop(text, language) {
  return language === 'fr' ? /arr[êe]t/i.test(text) : /\bstop/i.test(text);
}

/** The coach says plainly that it is an AI. */
export function saysAi(text, language) {
  return language === 'fr' ? /\bIA\b|intelligence artificielle/.test(text) : /\bAI\b/.test(text);
}
