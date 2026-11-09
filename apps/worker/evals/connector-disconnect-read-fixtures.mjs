// connector-disconnect-read eval fixtures (VIL-156). Every text here passes the regex
// pre-filter in apps/web/lib/channel/connect/detect.ts (disconnect-read.test.ts pins
// that), so each one is a turn the model really reads. A `disconnect` reading revokes
// Hale's whole Google grant, so the two question shapes the refuter found on main are
// pinned as `question`.

export const CONNECTOR_DISCONNECT_READ_FIXTURES = [
  {
    id: 'en-disconnect-calendar',
    text: 'disconnect my calendar',
    language: 'en',
    expect: 'disconnect',
  },
  { id: 'en-unlink-gmail', text: 'unlink my gmail', language: 'en', expect: 'disconnect' },
  {
    id: 'fr-disconnect-calendar',
    text: 'déconnecte mon agenda',
    language: 'fr',
    expect: 'disconnect',
  },
  {
    id: 'en-disconnect-calendar-now',
    text: 'disconnect google calendar now',
    language: 'en',
    expect: 'disconnect',
  },
  {
    id: 'en-how-do-i',
    text: 'how do I disconnect my calendar?',
    language: 'en',
    expect: 'question',
  },
  {
    id: 'en-what-if',
    text: 'if I disconnect my calendar will I lose gmail?',
    language: 'en',
    expect: 'question',
  },
  {
    id: 'en-might-later',
    text: 'i might disconnect my calendar later, how does that work',
    language: 'en',
    expect: 'question',
  },
  { id: 'fr-how-do-i', text: 'comment je déconnecte gmail ?', language: 'fr', expect: 'question' },
  {
    id: 'en-work-laptop',
    text: 'my work laptop made me disconnect my calendar yesterday',
    language: 'en',
    expect: 'other',
  },
  {
    id: 'en-not-from-hale',
    text: 'I had to disconnect my calendar at work today, not from hale',
    language: 'en',
    expect: 'other',
  },
];
