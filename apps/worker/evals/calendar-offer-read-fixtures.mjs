// Calendar-offer readings. Expectations come from the skill, not from a recorded answer.
//
// The parent fixtures include Chinese and Arabic. A phrase list cannot pass them.
// The coach fixtures are one future add and one occasion that has already started.

const SUNDAY = '8c4e1a70-2b95-4d16-9f38-71a0c5e24b6d';
const THURSDAY = '1f7b3d92-6e04-4a58-8c21-d5e9b0a47c13';

const SUNDAY_OFFER = {
  id: SUNDAY,
  kind: 'email_alert_add',
  description: 'An offer to put Gymnastics on your week, starting 2026-10-04T13:00:00.000Z',
  answerable: { yes: true, no: true },
};

const THURSDAY_OFFER = {
  id: THURSDAY,
  kind: 'email_alert_add',
  description: 'An offer to put Gymnastics on your week, starting 2026-10-01T20:15:00.000Z',
  answerable: { yes: true, no: true },
};

/** VIL-302 · the offer a coach search reply made, the newest ask Hale is holding. */
const SEARCH_OFFER = {
  id: '4d2a9c17-58e3-4b06-a1f4-93c7e0b25d68',
  kind: 'email_alert_add',
  description: 'An offer to put Toddler Swim on your week, starting 2026-08-22T14:00:00.000Z',
  answerable: { yes: true, no: true },
};

export const CALENDAR_OFFER_FIXTURES = [
  {
    id: 'parent-zh-sunday',
    role: 'parent',
    text: '好的，就周日早上九点的体操',
    now: '2026-10-02T15:00:00.000Z',
    timeZone: 'America/Toronto',
    questions: [SUNDAY_OFFER, THURSDAY_OFFER],
    expect: { status: 'resolved', questionId: SUNDAY, polarity: 'yes' },
    why: 'Chinese agreement names Sunday gymnastics, not the Thursday class.',
  },
  {
    id: 'parent-ar-no',
    role: 'parent',
    text: 'لا، ليس هذا',
    now: '2026-10-02T15:00:00.000Z',
    timeZone: 'America/Toronto',
    questions: [SUNDAY_OFFER],
    expect: { status: 'resolved', questionId: SUNDAY, polarity: 'no' },
    why: 'Arabic refusal of the one open offer. A Latin decline list cannot read it.',
  },
  {
    id: 'coach-future-sunday',
    role: 'coach',
    text: 'Want me to add Gymnastics on Sunday, Oct 4 at 9:00 a.m.?',
    now: '2026-10-02T15:00:00.000Z',
    timeZone: 'America/Toronto',
    questions: [],
    expect: {
      status: 'offer',
      title: 'Gymnastics',
      startsAt: '2026-10-04T13:00:00.000Z',
    },
    why: 'One specific future add. 9:00 a.m. Toronto in October is 13:00 UTC.',
  },
  {
    id: 'vil-410-bare-yes',
    role: 'parent',
    text: 'yes',
    now: '2026-10-02T15:00:00.000Z',
    timeZone: 'America/Toronto',
    questions: [THURSDAY_OFFER, SUNDAY_OFFER],
    pastOfferId: THURSDAY,
    expect: { status: 'unresolved', reason: 'ambiguous' },
    why: 'VIL-410, 2026-10-02. A bare yes added Gymnastics Thu Oct 1 4:15pm (2026-10-01T20:15:00.000Z). That start was already past. Sunday Oct 4 9:00 a.m. was the other offer. A bare yes names neither and must not place Thursday.',
  },
  {
    id: 'coach-past-thursday',
    role: 'coach',
    text: 'Want me to add Gymnastics on Thursday, Oct 1 at 4:15 p.m.?',
    now: '2026-10-02T15:00:00.000Z',
    timeZone: 'America/Toronto',
    questions: [],
    expect: { status: 'none' },
    why: 'Thursday has already started. The skill says that is not an offer.',
  },
  {
    id: 'vil-302-bare-yes-newest-offer',
    role: 'parent',
    text: 'yes',
    now: '2026-08-20T18:18:00.000Z',
    timeZone: 'America/New_York',
    questions: [SEARCH_OFFER],
    expect: { status: 'resolved', questionId: SEARCH_OFFER.id, polarity: 'yes' },
    why: 'VIL-302, 2026-08-20. An intro was asked earlier; the search offer is the newest ask, so the router reads the bare yes against it alone. One open offer and a plain yes: it is that offer.',
  },
  {
    id: 'vil-302-names-an-older-ask',
    role: 'parent',
    text: 'yes to meeting the other family',
    now: '2026-08-20T18:18:00.000Z',
    timeZone: 'America/New_York',
    questions: [SEARCH_OFFER],
    expect: { status: 'unresolved', reason: 'no_target' },
    why: 'VIL-302. The same narrowed read, but the parent named the older intro ask. Not about this offer, so it must be none, and the router then reads it against everything open.',
  },
  {
    id: 'vil-302-declines-an-older-ask',
    role: 'parent',
    text: 'no thanks to the intro',
    now: '2026-08-20T18:18:00.000Z',
    timeZone: 'America/New_York',
    questions: [SEARCH_OFFER],
    // RECORDED HAZARD, not an aspiration (the french-consent pattern in the reply-resolver
    // corpus). Shown only the newest offer, the real model reads "no thanks to the intro"
    // as a high-confidence NO to that offer: it took "the intro" to mean the offer. That
    // reading would drop a find the parent never declined. It is why the router reads the
    // whole open list FIRST and narrows to the newest ask only when the whole-list read is
    // `ambiguous` (route.ts, resolveNaturalReply): words that name an older ask get placed
    // on the whole list and never reach this narrowed read. If this fixture starts failing
    // because the model says none, the narrowed read became safer; it is not a regression.
    expect: { status: 'resolved', questionId: SEARCH_OFFER.id, polarity: 'no' },
    why: 'VIL-302 hazard. A no naming the older intro ask, read against the newest offer alone, is misread as a no to the offer. The router must never send this read first.',
  },
];
