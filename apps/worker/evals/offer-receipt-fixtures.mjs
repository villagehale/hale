// The offer receipt — the corpus.
//
// Facts only. A judge scores whether the text matches them, and the tone. No phrase
// is required. Unrecorded: run with --max-usd 0.05 to record, then --cached-only.

const CARPOOL = {
  happened: 'added',
  title: "Ava's carpool",
  when: 'Saturday, Nov 7 at 8:00 a.m.',
  language: null,
  placedOn: 'hale_family_calendar',
  alsoOnGoogle: false,
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
      'Added. language is null, so the line follows parentWords. placedOn is hale_family_calendar. googleCalendarConnected is false. alsoOnGoogle is false, so the save is not on Google. address is tu. Title and rendered instant unchanged. Short, warm, first person. No booking, registration, or payment.',
  },
  {
    id: 'en-hale-google-connected',
    facts: {
      ...CARPOOL,
      parentReply: 'Yes',
      googleCalendarConnected: true,
    },
    watchFor:
      'Added. language is null, so the line follows parentWords. googleCalendarConnected is true and alsoOnGoogle is false: the calendar is connected and this save was not written to it. placedOn is hale_family_calendar. address is tu. Title and rendered instant unchanged. Short, warm, first person. No booking, registration, or payment.',
  },
  {
    id: 'fr-hale-no-google',
    facts: {
      ...CARPOOL,
      parentReply: 'Oui, ça me va',
      googleCalendarConnected: false,
    },
    watchFor:
      'Added. language is null, so the line follows parentWords, which are not English. address is tu. placedOn is hale_family_calendar. googleCalendarConnected is false. alsoOnGoogle is false, so the save is not on Google. Title and rendered instant unchanged and not translated. Short, warm, first person. No booking, registration, or payment.',
  },
];
