// The offer receipt — the corpus.
//
// Facts only. A judge scores whether the text matches them, and the tone. No phrase
// is required. Unrecorded: run with --max-usd 0.05 to record, then --cached-only.

const CARPOOL = {
  happened: 'added',
  title: "Ava's carpool",
  when: 'Saturday, Nov 7 at 8:00 a.m.',
  placedOn: 'hale_family_calendar',
};

export const OFFER_RECEIPT_FIXTURES = [
  {
    id: 'en-hale-no-google',
    facts: {
      ...CARPOOL,
      parentReply: 'Yes',
      googleCalendarConnected: false,
    },
    watchFor:
      'Added. The only place is Hale’s family calendar. Google calendar is not connected, so the entry is not on the parent’s Google calendar. Title and rendered instant unchanged. English. Short, warm, first person. No booking, registration, or payment.',
  },
  {
    id: 'en-hale-google-connected',
    facts: {
      ...CARPOOL,
      parentReply: 'Yes',
      googleCalendarConnected: true,
    },
    watchFor:
      'Added. Google calendar is connected, and the entry still went only to Hale’s family calendar. Title and rendered instant unchanged. English. Short, warm, first person. No booking, registration, or payment.',
  },
  {
    id: 'fr-hale-no-google',
    facts: {
      ...CARPOOL,
      parentReply: 'Oui, ça me va',
      googleCalendarConnected: false,
    },
    watchFor:
      'Added. French, tu, answering the parent. The only place is Hale’s family calendar. Google calendar is not connected. Title and rendered instant unchanged, not translated. Short, warm, first person. No booking, registration, or payment.',
  },
];
