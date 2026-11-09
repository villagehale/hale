/**
 * The model fields friend-voice.ts reads instead of a text match:
 * `asks`, `parentQuestion`, `connectorsOffered`, `joinPointer`, `claimsSaved`. These strings are
 * the cases, not a matcher: code does not decide intent from them.
 *
 * `emits` lists the fields the model must return on that turn, with a value of
 * the right type, because the send depends on them there. `expect` is what the
 * value must be. An omitted `joinPointer` under a co-parent yes means nothing
 * is sent, so that fixture carries the pointer in both. `offersOther` is
 * whether `connectorsOffered` holds the connector this step is not: code
 * refuses that reply under this step's link. `noYesIn` names the
 * connector a question must not turn into a yes: code clears that yes only
 * when `parentQuestion` is set, so a yes without it is a miss.
 */

const DONE_THROUGH_NAME = {
  postal: true,
  kids: true,
  ages: true,
  name: true,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};
const DONE_THROUGH_SCHEDULE = {
  ...DONE_THROUGH_NAME,
  gmail: true,
  calendar: true,
  schedule: true,
};

const CARPOOL_TURN = {
  step: 'coparent',
  parentWords:
    "No calendar for now. Just save Mia's carpool, tomorrow Saturday 8am, and tell me what day and time you saved.",
  language: null,
  parentName: 'Dana',
  agesLabel: 'Mia (4) and Leo (2)',
  ageMonths: [48, 24],
  children: [
    { name: 'Mia', ageMonths: 48 },
    { name: 'Leo', ageMonths: 24 },
  ],
  // Sunday 10:28 p.m. Eastern: tomorrow is Monday.
  now: new Date('2026-11-02T03:28:00Z'),
  timeZone: 'America/Toronto',
  scheduled: [],
  recentTurns: [
    { role: 'parent', body: "Mia has carpool tomorrow at 8am, it's a Saturday thing" },
    {
      role: 'hale',
      body: 'Carpool tomorrow at 8, got it. Would you like to connect your calendar?',
      asked: true,
    },
  ],
  checklist: { ...DONE_THROUGH_SCHEDULE, coparent: false },
};

export const FRIEND_MARKS_FIXTURES = [
  {
    id: 'name-ask',
    over: { step: 'names', parentWords: 'ok' },
    emits: ['asks'],
    expect: { asks: true },
  },
  {
    id: 'ack-no-ask',
    over: {
      step: 'ack',
      parentWords: 'sounds good',
      parentName: 'Dana',
      granted: true,
      checklist: { ...DONE_THROUGH_SCHEDULE, coparent: true },
    },
    emits: ['asks', 'claimsSaved'],
    expect: { asks: false, claimsSaved: false },
  },
  {
    id: 'email-yes',
    over: {
      step: 'email',
      parentWords: 'yes sure',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    // No offersOther: the email ask sometimes also offers the calendar. The
    // field then lists it and code refuses that draft, which is the gate working.
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: false },
  },
  {
    id: 'email-question-zh',
    over: {
      step: 'email',
      language: 'zh',
      parentWords: '你会看我所有的邮件吗',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: true },
    offersOther: false,
    noYesIn: 'connectGmail',
  },
  {
    id: 'email-question-fr',
    over: {
      step: 'email',
      language: 'fr',
      parentWords: 'tu vas lire tous mes courriels',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: {},
    offersOther: false,
    noYesIn: 'connectGmail',
  },
  {
    id: 'calendar-yes',
    over: {
      step: 'calendar',
      parentWords: 'yep go ahead',
      parentName: 'Dana',
      checklist: { ...DONE_THROUGH_NAME, gmail: true },
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: false },
    offersOther: false,
  },
  {
    id: 'calendar-wants-gmail',
    over: {
      step: 'calendar',
      parentWords: 'can we do my gmail first instead',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: {},
    offersOther: true,
    noYesIn: 'connectCalendar',
  },
  {
    id: 'coparent-yes-join',
    over: {
      step: 'coparent',
      parentWords: 'yes that would help',
      parentName: 'Dana',
      coparentJoin: { line: '(555) 555-0142', phrase: 'Hale group' },
      checklist: DONE_THROUGH_SCHEDULE,
    },
    emits: ['asks', 'parentQuestion', 'joinPointer'],
    expect: { parentQuestion: false, joinPointer: 'below' },
  },
  {
    id: 'coparent-no',
    over: {
      step: 'coparent',
      parentWords: 'no thanks, just me',
      parentName: 'Dana',
      coparentJoin: { line: '(555) 555-0142', phrase: 'Hale group' },
      checklist: DONE_THROUGH_SCHEDULE,
    },
    emits: ['asks', 'parentQuestion'],
    expect: { parentQuestion: false },
  },
  // VIL-538: the Preview turn. An English parent, on the co-parent step, asks to
  // save something that is not a map line, with a "tomorrow Saturday" that is a
  // Monday. Nothing can be saved here, so the reply must not say it was.
  {
    id: 'coparent-carpool',
    over: CARPOOL_TURN,
    emits: ['asks', 'claimsSaved'],
    // A draft that tries an add and confirms it is refused by code and retried;
    // a confirmation with no add at all is the leak.
    expect: {},
    savedOnlyWithAdds: true,
    plainLatin: true,
    printReply: true,
  },
  // The retry that produced the French "enregistrée": same turn, short prompt,
  // handed the refused draft.
  {
    id: 'coparent-carpool-retry',
    prompt: 'short',
    over: CARPOOL_TURN,
    retry: {
      draft:
        "Got it, no calendar for now. Mia's carpool is saved for tomorrow, Saturday at 8am. Would a group chat with the other parent help?",
      reason: 'schedule',
    },
    emits: ['asks', 'claimsSaved'],
    expect: { claimsSaved: false },
    plainLatin: true,
    printReply: true,
  },
  // A stored French tag is only a hint: the English words in front of it win.
  {
    id: 'coparent-carpool-retry-fr-hint',
    prompt: 'short',
    over: { ...CARPOOL_TURN, language: 'fr', address: 'tu' },
    retry: {
      draft:
        "Got it, no calendar for now. Mia's carpool is saved for tomorrow, Saturday at 8am. Would a group chat with the other parent help?",
      reason: 'schedule',
    },
    emits: ['asks', 'claimsSaved'],
    expect: { claimsSaved: false },
    plainLatin: true,
    printReply: true,
  },
  // Positive control: a map line they said yes to is saved, and the reply says so.
  {
    id: 'schedule-add-saved',
    over: {
      step: 'schedule',
      parentWords: "Yes please, put Mia's swim on every week",
      parentName: 'Dana',
      agesLabel: 'Mia (6)',
      ageMonths: [72],
      children: [{ name: 'Mia', ageMonths: 72 }],
      findLines: ['Swim Kids 3 (ages 6-8) - Saturdays 11:00'],
      listKind: 'week',
      now: new Date('2026-11-02T15:00:00Z'),
      timeZone: 'America/Toronto',
      scheduled: [],
      recentTurns: [
        {
          role: 'hale',
          body: 'Swim Kids 3 on Saturdays at 11 fits Mia. Want a reminder for it?',
          asked: true,
        },
      ],
      checklist: { ...DONE_THROUGH_NAME, gmail: true, calendar: true },
    },
    emits: ['asks', 'claimsSaved'],
    expect: { claimsSaved: true },
    addsAtLeast: 1,
  },
];

const OTHER_CONNECTOR = { email: 'calendar', calendar: 'gmail' };

const FIELD_TYPE = {
  asks: (v) => typeof v === 'boolean',
  parentQuestion: (v) => typeof v === 'boolean',
  connectorsOffered: (v) =>
    Array.isArray(v) && v.every((item) => item === 'gmail' || item === 'calendar'),
  claimsSaved: (v) => typeof v === 'boolean',
  joinPointer: (v) =>
    v === null || ['below', 'wrong_owner', 'placeholder', 'hale_starts', 'missing'].includes(v),
};

/** The fields this fixture needed and the model left out or mistyped. Empty is a pass. */
export function friendMarksMisses(fixture, value) {
  const misses = [];
  for (const field of fixture.emits) {
    if (!value || !(field in value) || !FIELD_TYPE[field](value[field])) {
      misses.push(`${field}:omitted`);
    }
  }
  if ('offersOther' in fixture) {
    const offered = Array.isArray(value?.connectorsOffered) ? value.connectorsOffered : [];
    const other = offered.includes(OTHER_CONNECTOR[fixture.over.step]);
    if (other !== fixture.offersOther) misses.push(`connectorsOffered:${JSON.stringify(offered)}`);
  }
  if (fixture.noYesIn && value?.[fixture.noYesIn] === true && value?.parentQuestion !== true) {
    misses.push(`${fixture.noYesIn}:yes_kept`);
  }
  // An English parent gets an English reply: no accented letters in it.
  if (fixture.plainLatin && /[\u00c0-\u024f]/u.test(String(value?.reply ?? ''))) {
    misses.push('reply:not_their_language');
  }
  if (fixture.savedOnlyWithAdds && value?.claimsSaved === true) {
    const adds = Array.isArray(value?.scheduleAdds) ? value.scheduleAdds.length : 0;
    if (adds === 0) misses.push('claimsSaved:no_add');
  }
  if (fixture.addsAtLeast) {
    const adds = Array.isArray(value?.scheduleAdds) ? value.scheduleAdds.length : 0;
    if (adds < fixture.addsAtLeast) misses.push(`scheduleAdds:${adds}`);
  }
  for (const [field, want] of Object.entries(fixture.expect)) {
    const got = value?.[field];
    if (got !== want) misses.push(`${field}:${JSON.stringify(got ?? null)}`);
  }
  return misses;
}
