// VIL-444 (T24) group clash alert fixtures. Fake families only.
//
// Each fixture is what Hale may read for one household: calendar rows as
// parent_calendar_blocks keeps them (a null title is a non-kid block, kept as busy time),
// Hale-held plans from family_events, and who is in the group chat. The runner turns them
// into the planner's input with the real code (group-conflict.ts), so a fixture never
// states the clash; it states the calendars.
//
// `expect` is the planner's answer: no alert, or the alert's shape (what the second item
// is, who is suggested, who may be asked). `mustNotLeak` lists private words that must not
// reach the model or the group. `watchFor` is for the judge only.

const TORONTO = 'America/Toronto';
const barton = { id: 'barton', name: 'Barton', calendar: true };
const sam = { id: 'sam', name: 'Sam', calendar: true };
const nana = { id: 'nana', name: 'Nana', calendar: false };

const twoPickups = [
  {
    owner: 'barton',
    eventId: 'swim',
    title: 'Maya swim pickup',
    start: '2026-09-25T19:00:00.000Z',
    end: '2026-09-25T19:30:00.000Z',
  },
  {
    owner: 'barton',
    eventId: 'daycare',
    title: 'Leo daycare pickup',
    start: '2026-09-25T19:00:00.000Z',
    end: '2026-09-25T19:30:00.000Z',
  },
];

export const GROUP_CONFLICT_ALERT_FIXTURES = [
  {
    id: 'en-two-pickups-sam-free',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    expect: { second: 'plan', suggested: 'Sam', busy: [], couldAsk: [] },
    watchFor:
      "Both pickups are Friday at 3 and both are Barton's. Sam is free then on their calendar, so the fix is Sam taking Maya's swim pickup.",
  },
  {
    id: 'en-private-busy',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya'],
    people: [barton, sam],
    blocks: [
      twoPickups[0],
      {
        owner: 'barton',
        eventId: 'placed-allergist',
        title: 'Maya allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
      },
    ],
    events: [
      {
        id: 'allergist',
        title: 'Maya allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
        private: true,
        owner: { kind: 'parent', userId: 'barton' },
        placedGoogleEventId: 'placed-allergist',
      },
    ],
    expect: { second: 'busy', suggested: 'Sam', busy: ['Barton'], couldAsk: [] },
    mustNotLeak: ['allergist'],
    watchFor:
      "Barton is busy then with something private: it may only be called busy (or tied up), never what it is, never that it is hidden, never its own times. Sam is free on their calendar, so the fix is Sam taking Maya's swim pickup on Friday at 3.",
  },
  {
    id: 'fr-practice-onto-recital',
    language: 'fr',
    timeZone: TORONTO,
    now: '2026-10-01T14:00:00.000Z',
    kids: ['Léa', 'Chloé'],
    people: [
      { id: 'emilie', name: 'Émilie', calendar: true },
      { id: 'julien', name: 'Julien', calendar: false },
      { id: 'mamie', name: 'Mamie', calendar: false },
    ],
    blocks: [
      {
        owner: 'emilie',
        eventId: 'recital',
        title: 'Récital de piano de Léa',
        start: '2026-10-02T22:00:00.000Z',
        end: '2026-10-02T23:30:00.000Z',
      },
      {
        owner: 'emilie',
        eventId: 'soccer',
        title: 'Entraînement de soccer de Chloé',
        start: '2026-10-02T22:00:00.000Z',
        end: '2026-10-02T23:00:00.000Z',
      },
    ],
    events: [],
    expect: { second: 'plan', suggested: null, busy: [], couldAsk: ['Julien', 'Mamie'] },
    watchFor:
      "Chloé's soccer practice now falls on Léa's piano recital, Friday at 18:00, and Émilie has both. Nobody is free on a calendar Hale can see: it should say so and ask Julien or Mamie whether one of them can take one, without calling either of them free. French, vous.",
  },
  {
    id: 'en-same-kid',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya'],
    people: [barton, sam],
    blocks: [
      twoPickups[0],
      {
        owner: 'barton',
        eventId: 'dentist',
        title: 'Maya dentist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T19:45:00.000Z',
      },
    ],
    events: [],
    expect: { second: 'plan', suggested: 'Sam', busy: [], couldAsk: [] },
    watchFor:
      "Both items are Maya's, Friday at 3: a second driver does not fix that, because Maya cannot be in two places. It should say Maya is double-booked and ask which one she is going to, not hand Sam one of them.",
  },
  {
    id: 'en-recital-practice-covered',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: [
      {
        owner: 'barton',
        eventId: 'recital',
        title: 'Maya recital',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
      },
      {
        owner: 'sam',
        eventId: 'practice',
        title: 'Leo practice',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T19:30:00.000Z',
      },
    ],
    events: [],
    expect: null,
  },
  {
    id: 'en-no-repeat',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T18:00:00.000Z',
    alreadySentAt: '2026-09-25T17:30:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    expect: null,
  },
  {
    id: 'en-container',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-25T11:00:00.000Z',
    kids: ['Maya', 'Leo'],
    people: [barton, sam],
    blocks: [
      {
        owner: 'barton',
        eventId: 'school',
        title: 'Maya school',
        start: '2026-09-25T12:30:00.000Z',
        end: '2026-09-25T19:30:00.000Z',
      },
      twoPickups[1],
    ],
    events: [],
    expect: null,
  },
];

// Pickup claims: one group message read for whether the sender took, or gave back, a plan.
//
// The household is stated the same way, plus the who-takes decisions already stored
// (`decisions`), when an earlier sweep sent the alert (`alertSentAt`), who wrote (`sender`),
// what they wrote, and the chat lines before it (`recent`). The runner builds what the
// reader is offered with the real code (group-pickup-claim.ts).
//
// `expect.action` is what the reading must do: take (`claim`) or give back (`drop`) exactly
// the `pickups` named by title, or nothing (null). `expect.alertAfter` is whether the group
// still has an alert coming once that is stored: a claimed pickup is settled, so no alert
// names it. Every fixture offers at least two pickups and expects fewer than all of them,
// so a reader that takes everything fails each one.

const hasBothAlert = {
  from: 'hale',
  text: "Maya's swim pickup and Leo's daycare pickup are both Friday at 3, and Barton has both. Sam, could you take Maya's swim pickup?",
};

export const GROUP_PICKUP_CLAIM_FIXTURES = [
  {
    id: 'en-handoff-before-alert',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    sender: 'sam',
    text: "I'll pick Maya up from swim tomorrow. Barton, you've got Leo.",
    recent: [{ from: 'member', text: 'Friday at 3 I somehow have both pickups' }],
    expect: { action: 'claim', pickups: ['Maya swim pickup'], alertAfter: false },
  },
  {
    id: 'en-short-yes-to-ask',
    language: 'en',
    timeZone: TORONTO,
    alertSentAt: '2026-09-24T13:00:00.000Z',
    now: '2026-09-24T13:20:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    sender: 'sam',
    text: 'yep can do',
    recent: [hasBothAlert],
    expect: { action: 'claim', pickups: ['Maya swim pickup'], alertAfter: false },
  },
  {
    id: 'en-keeps-one-asks-other',
    language: 'en',
    timeZone: TORONTO,
    alertSentAt: '2026-09-24T13:00:00.000Z',
    now: '2026-09-24T13:25:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    sender: 'barton',
    text: "I'd rather do Maya's swim myself. Sam, can you grab Leo from daycare instead?",
    recent: [hasBothAlert],
    expect: { action: 'claim', pickups: ['Maya swim pickup'], alertAfter: false },
  },
  {
    id: 'en-gives-back-own',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T22:00:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    decisions: [
      {
        title: 'Maya swim pickup',
        start: '2026-09-25T19:00:00.000Z',
        takerId: 'sam',
        at: '2026-09-23T20:00:00.000Z',
        claim: true,
      },
    ],
    sender: 'sam',
    text: "Sorry, my shift moved and I can't do Maya's swim pickup tomorrow after all.",
    recent: [],
    expect: { action: 'drop', pickups: ['Maya swim pickup'], alertAfter: true },
  },
  {
    id: 'fr-takes-the-other-one',
    language: 'fr',
    timeZone: TORONTO,
    alertSentAt: '2026-10-01T13:00:00.000Z',
    now: '2026-10-01T13:30:00.000Z',
    people: [
      { id: 'emilie', name: 'Émilie', calendar: true },
      { id: 'julien', name: 'Julien', calendar: true },
    ],
    blocks: [
      {
        owner: 'emilie',
        eventId: 'natation',
        title: 'Ramener Léa de la natation',
        start: '2026-10-02T21:30:00.000Z',
        end: '2026-10-02T22:00:00.000Z',
      },
      {
        owner: 'emilie',
        eventId: 'soccer',
        title: 'Conduire Chloé au soccer',
        start: '2026-10-02T21:30:00.000Z',
        end: '2026-10-02T22:00:00.000Z',
      },
    ],
    events: [],
    sender: 'julien',
    text: 'Je ne peux pas pour la natation, mais je conduis Chloé au soccer.',
    recent: [
      {
        from: 'hale',
        text: 'Ramener Léa de la natation et conduire Chloé au soccer tombent tous les deux vendredi à 17 h 30, et Émilie a les deux. Julien, pourriez-vous ramener Léa de la natation ?',
      },
    ],
    expect: { action: 'claim', pickups: ['Conduire Chloé au soccer'], alertAfter: false },
  },
  {
    id: 'en-takes-hale-held-plan',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam],
    blocks: [
      {
        owner: 'barton',
        eventId: 'hockey',
        title: 'Leo hockey drop-off',
        start: '2026-09-26T14:00:00.000Z',
        end: '2026-09-26T14:30:00.000Z',
      },
    ],
    events: [
      {
        id: 'swim-lesson',
        title: 'Maya swim lesson',
        start: '2026-09-26T14:00:00.000Z',
        end: '2026-09-26T15:00:00.000Z',
        private: false,
        owner: { kind: 'parent', userId: 'barton' },
        ownerSince: '2026-09-20T12:00:00.000Z',
        placedGoogleEventId: null,
      },
    ],
    sender: 'sam',
    text: "I'll take Maya to her swim lesson on Saturday.",
    recent: [],
    expect: { action: 'claim', pickups: ['Maya swim lesson'], alertAfter: false },
  },
  {
    id: 'en-should-i-question',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    sender: 'sam',
    text: 'Should I get Maya from swim on Friday?',
    recent: [],
    expect: { action: null, alertAfter: true },
  },
  {
    id: 'en-maybe-after-checking',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam],
    blocks: twoPickups,
    events: [],
    sender: 'sam',
    text: "Maybe, if I can get out of work early. I'll check and let you know.",
    recent: [{ from: 'member', text: 'Can anyone take Maya to swim Friday at 3?' }],
    expect: { action: null, alertAfter: true },
  },
  {
    id: 'en-someone-else-said',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam, nana],
    blocks: twoPickups,
    events: [],
    sender: 'nana',
    text: "Sam said he'd grab Maya from swim on Friday.",
    recent: [],
    expect: { action: null, alertAfter: true },
  },
  {
    id: 'en-which-one-unclear',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam, nana],
    blocks: twoPickups,
    events: [],
    sender: 'nana',
    text: 'I could take one of them if that helps!',
    recent: [{ from: 'member', text: 'I have both pickups Friday at 3, ugh' }],
    expect: { action: null, alertAfter: true },
  },
  {
    id: 'en-private-never-offered',
    language: 'en',
    timeZone: TORONTO,
    now: '2026-09-24T14:00:00.000Z',
    people: [barton, sam],
    blocks: [
      twoPickups[0],
      {
        owner: 'barton',
        eventId: 'placed-allergist',
        title: 'Leo allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
      },
      {
        owner: 'sam',
        eventId: 'daycare-late',
        title: 'Leo daycare pickup',
        start: '2026-09-25T21:00:00.000Z',
        end: '2026-09-25T21:30:00.000Z',
      },
    ],
    events: [
      {
        id: 'allergist',
        title: 'Leo allergist',
        start: '2026-09-25T19:00:00.000Z',
        end: '2026-09-25T20:00:00.000Z',
        private: true,
        owner: { kind: 'parent', userId: 'barton' },
        ownerSince: null,
        placedGoogleEventId: 'placed-allergist',
      },
    ],
    sender: 'sam',
    text: "I'll take Leo to his allergist appointment on Friday.",
    recent: [],
    expect: { action: null, alertAfter: true },
    mustNotLeak: ['allergist'],
  },
];
