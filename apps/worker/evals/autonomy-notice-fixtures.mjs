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
      detail: { to: 'school@example.com', subject: 'pickup' },
      why: 'the kind was on',
    },
  },
  {
    id: 'armed-email-zh',
    context: {
      occasion: 'armed',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['帮我给学校发个邮件'],
      detail: null,
    },
  },
  {
    id: 'armed-email-ar',
    context: {
      occasion: 'armed',
      actionType: 'reply_to_email',
      localeHint: null,
      recentInbound: ['رد على بريد المدرسة'],
      detail: null,
    },
  },
  {
    id: 'armed-calendar-move-en',
    context: {
      occasion: 'armed',
      actionType: 'calendar_move',
      localeHint: null,
      recentInbound: ['move it on the calendar'],
      detail: null,
    },
  },
  {
    id: 'combined-armed-acted-en',
    context: {
      occasion: 'armed',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['can you email the school for me'],
      detail: null,
      items: [
        {
          occasion: 'armed',
          actionType: 'send_email',
          detail: null,
          why: null,
          standing: {
            may: {
              sendEmail: true,
              replyToEmail: false,
              addToCalendar: false,
              updateCalendar: false,
              moveCalendar: false,
              cancelCalendar: false,
              sharePhotos: false,
              addToDigest: false,
              addToRoutine: false,
            },
            never: ['book', 'register', 'pay'],
            stop: 'one_message',
          },
        },
        {
          occasion: 'acted',
          actionType: 'send_email',
          detail: { to: 'school@example.com', subject: 'pickup' },
          why: 'the kind was on',
          standing: { may: null, never: null, stop: 'one_message' },
        },
      ],
    },
  },
  {
    id: 'combined-two-acted-en',
    context: {
      occasion: 'acted',
      actionType: 'send_email',
      localeHint: null,
      recentInbound: ['email them for me'],
      detail: { to: 'school@example.com', subject: 'pickup' },
      why: 'the kind was on',
      items: [
        {
          occasion: 'acted',
          actionType: 'send_email',
          detail: { to: 'school@example.com', subject: 'pickup' },
          why: 'the kind was on',
          standing: { may: null, never: null, stop: 'one_message' },
        },
        {
          occasion: 'acted',
          actionType: 'calendar_add',
          detail: { title: 'soccer' },
          why: 'the kind was on',
          standing: { may: null, never: null, stop: 'one_message' },
        },
      ],
    },
  },
];
