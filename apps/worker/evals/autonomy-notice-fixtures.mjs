/**
 * Turn-on, re-arm, and on-its-own notices. The model writes the text. The runtime
 * check is structural (readAutonomyNotice). Tone is the judge.
 */

export const AUTONOMY_NOTICE_FIXTURES = [
  {
    id: 'armed-email-en',
    context: {
      occasion: 'armed',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['can you email the school for me'],
      detail: null,
    },
  },
  {
    id: 'rearmed-email-fr',
    context: {
      occasion: 'rearmed',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['tu peux recommencer les courriels'],
      detail: null,
    },
  },
  {
    id: 'armed-calendar-en',
    context: {
      occasion: 'armed',
      actionType: 'calendar_add',
      localeHint: null,
      recentInbound: ['add it on the calendar'],
      detail: null,
    },
  },
  {
    id: 'acted-email-en',
    context: {
      occasion: 'acted',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['email them for me'],
      detail: null,
    },
  },
];
