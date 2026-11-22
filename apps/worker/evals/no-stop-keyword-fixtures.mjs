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

// Doubt that is not a question about who is texting. "Is this a real person" or "is this a
// scam" is read as `identity` and answered by the said-line writer before the coach runs, so
// it would prove this prompt on a turn that never reaches it. The suite reads each text with
// the real opt-out-read request first and fails the case unless it comes back `none`.
export const COACH_DOUBT_FIXTURES = [
  { id: 'doubt-trust-kids', language: 'en', text: 'why should i trust you with my kids stuff' },
  { id: 'doubt-get-it-wrong', language: 'en', text: 'how do i know you wont get this all wrong' },
  { id: 'doubt-ai', language: 'en', text: 'i dont really trust ai with anything about my kids' },
  {
    id: 'doubt-fr',
    language: 'fr',
    text: 'pourquoi je te ferais confiance avec les infos de mes enfants',
  },
];

/** The word for stopping in prose, in the fixture's language. A keyword is refused apart. */
export function saysStop(text, language) {
  return language === 'fr' ? /arr[êe]t/i.test(text) : /\bstop/i.test(text);
}

/** The coach says plainly that it is an AI. */
export function saysAi(text, language) {
  return language === 'fr' ? /\bIA\b|intelligence artificielle/.test(text) : /\bAI\b/.test(text);
}
