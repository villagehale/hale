/**
 * Turn-on, re-arm, and on-its-own notices. The model writes the text. The runtime
 * check is structural (readAutonomyNotice). Tone is the judge.
 */

export const AUTONOMY_NOTICE_FIXTURES = [
  {
    id: 'armed-email-en',
    context: { occasion: 'armed', actionType: 'send_email', language: 'en', detail: null },
  },
  {
    id: 'rearmed-email-fr',
    context: { occasion: 'rearmed', actionType: 'send_email', language: 'fr', detail: null },
  },
  {
    id: 'armed-calendar-en',
    context: { occasion: 'armed', actionType: 'calendar_add', language: 'en', detail: null },
  },
  {
    id: 'acted-email-en',
    context: { occasion: 'acted', actionType: 'send_email', language: 'en', detail: null },
  },
];
