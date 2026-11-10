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
 * when `parentQuestion` is set, so a yes without it is a miss. `offersNone` is a
 * turn whose reply must offer no connector at all. `sendable` is a reply that
 * must pass the code judge for its step, so code would send it. `throughCode` is a
 * turn graded on what speakFriend sends, after its refusal and its one rewrite.
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

const NOTHING_YET = {
  postal: false,
  kids: false,
  ages: false,
  name: false,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};

// VIL-617: the first ask, turned down. Both attempts must write a reply code sends.
const PLACE_DECLINED_EN = {
  step: 'place',
  parentWords: "I'd rather not give out my postal code",
  checklist: NOTHING_YET,
  recentTurns: [
    {
      role: 'hale',
      body: "Hi, I'm Hale. I find what's on for your kids near you. What's your postal code or ZIP?",
      asked: true,
    },
  ],
};
const PLACE_DECLINED_FR = {
  step: 'place',
  language: 'fr',
  parentWords: 'je préfère ne pas donner mon code postal',
  checklist: NOTHING_YET,
  recentTurns: [
    {
      role: 'hale',
      body: "Salut, c'est Hale. Je trouve ce qui se passe pour tes enfants près de chez toi. C'est quoi ton code postal?",
      asked: true,
    },
  ],
};
// The first attempt's draft as Preview refused it: two questions. The retry is
// told what this message should ask, as speakFriend tells it.
const PLACE_DECLINED_RETRY = {
  draft:
    "Totally fair, you don't have to share it. Could you tell me the city instead? Or just the first three characters?",
  reason: 'question',
  askNote: true,
};
const PLACE_DECLINED_RETRY_FR = {
  draft:
    'Pas de souci, tu n’es pas obligé. Tu peux me dire ta ville à la place? Ou juste les trois premiers caractères?',
  reason: 'question',
  askNote: true,
};

// VIL-641: a place turned down twice, per country. The first no gets the coarse code
// that fits (a Canadian code's first three characters, a US five-digit ZIP), marked
// `placeAsk: coarse` so code keeps it; the second turn carries that as
// `coarseCodeAsked`, settles the place with `placeDeclined` and moves on. Neither
// promises anything nearby.
function declineTurns(opening, firstNo, offer, secondNo, language) {
  const ask = { role: 'hale', body: opening, asked: true };
  return {
    first: {
      step: 'place',
      ...(language ? { language } : {}),
      parentWords: firstNo,
      checklist: NOTHING_YET,
      recentTurns: [ask],
    },
    second: {
      step: 'place',
      ...(language ? { language } : {}),
      parentWords: secondNo,
      coarseCodeAsked: true,
      checklist: NOTHING_YET,
      recentTurns: [
        ask,
        { role: 'parent', body: firstNo },
        { role: 'hale', body: offer, asked: true },
      ],
    },
  };
}
const DECLINE_CA = declineTurns(
  "Hi, I'm Hale. I find what's on for your kids. What's your postal code?",
  "I'd rather not give out my postal code",
  'No problem. Even the first three characters would do, that only shows the area. Want to share just those?',
  "no thanks, I'd rather not share any of it",
);
const DECLINE_US = declineTurns(
  "Hi, I'm Hale. I find what's on for your kids. What's your ZIP code?",
  "I'm not comfortable saying where we live",
  'Totally fair. A five-digit ZIP only shows the area, not your street. Want to share just that?',
  'no, not even the zip, sorry',
);
const DECLINE_FR = declineTurns(
  "Salut, c'est Hale. Je trouve ce qui se passe pour tes enfants. C'est quoi ton code postal?",
  'je préfère ne pas donner mon code postal',
  'Pas de souci. Les trois premiers caractères suffisent, ça montre juste le secteur. Tu veux me donner seulement ça?',
  'non, même pas ça, désolé',
  'fr',
);
const NOTHING_NEARBY =
  'Wrong: promising to find, tell or send what is on nearby, or another way to do that, while no place is known.';
const SECOND_NO_WATCH = `Right: accepts the no and moves on to the kids (their names or ages) as the one question, with no further ask for any code, ZIP, town or place. Wrong: asking for a code, a ZIP, a town or a place again. ${NOTHING_NEARBY}`;

const SWIM_LINE = 'Swim lessons at the community pool (ages 3-5) - Saturdays 10:00';
const STORY_LINE = 'Library storytime (all ages) - Tuesdays 10:30 - free';
const PLAY_LINE = 'Drop-in playgroup (0-6) - weekday mornings - free';

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
    expect: { parentQuestion: true },
    offersOther: false,
    noYesIn: 'connectGmail',
  },
  // A question about Gmail is never a yes to it, with or without the question mark.
  {
    id: 'email-question-en',
    over: {
      step: 'email',
      parentWords: 'do you read all my emails?',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: true },
    offersOther: false,
    noYesIn: 'connectGmail',
  },
  {
    id: 'email-question-en-no-mark',
    over: {
      step: 'email',
      parentWords: 'do you read all my emails',
      parentName: 'Dana',
      checklist: DONE_THROUGH_NAME,
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: true },
    offersOther: false,
    noYesIn: 'connectGmail',
  },
  // Their own ask, mid-intake and about something else: answered, with no Gmail pitch.
  {
    id: 'ages-own-question',
    over: {
      step: 'ages',
      parentWords: 'what kind of things do you find for them?',
      agesLabel: 'Mia and Leo',
      children: [
        { name: 'Mia', ageMonths: null },
        { name: 'Leo', ageMonths: null },
      ],
      checklist: { ...NOTHING_YET, postal: true, kids: true },
    },
    emits: ['asks', 'parentQuestion', 'connectorsOffered'],
    expect: { parentQuestion: true },
    offersNone: true,
    printReply: true,
  },
  {
    id: 'place-declined-en',
    over: PLACE_DECLINED_EN,
    emits: ['asks'],
    expect: { asks: true, postalCode: null },
    placeOpen: true,
    throughCode: true,
    printReply: true,
  },
  {
    id: 'place-declined-en-retry',
    prompt: 'short',
    over: PLACE_DECLINED_EN,
    retry: PLACE_DECLINED_RETRY,
    emits: ['asks'],
    expect: { asks: true, postalCode: null },
    sendable: true,
    printReply: true,
  },
  {
    id: 'place-declined-fr',
    over: PLACE_DECLINED_FR,
    emits: ['asks'],
    expect: { asks: true, postalCode: null },
    placeOpen: true,
    throughCode: true,
    printReply: true,
  },
  {
    id: 'place-declined-fr-retry',
    prompt: 'short',
    over: PLACE_DECLINED_FR,
    retry: PLACE_DECLINED_RETRY_FR,
    emits: ['asks'],
    expect: { asks: true, postalCode: null },
    sendable: true,
    printReply: true,
  },
  {
    id: 'place-decline-1-en-ca',
    over: DECLINE_CA.first,
    emits: ['asks', 'placeAsk'],
    expect: { asks: true, postalCode: null, placeAsk: 'coarse' },
    placeOpen: true,
    throughCode: true,
    watchFor: `Canada. Right: accepts the no and asks, as the one question, for just the first three characters of their postal code (offering a ZIP as well is fine). Wrong: asking for a town or a street. ${NOTHING_NEARBY}`,
    printReply: true,
  },
  {
    id: 'place-decline-2-en-ca',
    over: DECLINE_CA.second,
    emits: ['asks'],
    expect: { asks: true, postalCode: null, placeDeclined: true },
    throughCode: true,
    watchFor: SECOND_NO_WATCH,
    printReply: true,
  },
  {
    id: 'place-decline-1-en-us',
    over: DECLINE_US.first,
    emits: ['asks', 'placeAsk'],
    expect: { asks: true, postalCode: null, placeAsk: 'coarse' },
    placeOpen: true,
    throughCode: true,
    watchFor: `United States. Right: accepts the no and asks, as the one question, for just their five-digit ZIP, which shows the area and not their street (offering the first three characters of a Canadian postal code as well is fine). Wrong: asking for a town or a street. ${NOTHING_NEARBY}`,
    printReply: true,
  },
  {
    id: 'place-decline-2-en-us',
    over: DECLINE_US.second,
    emits: ['asks'],
    expect: { asks: true, postalCode: null, placeDeclined: true },
    throughCode: true,
    watchFor: SECOND_NO_WATCH,
    printReply: true,
  },
  {
    id: 'place-decline-1-fr',
    over: DECLINE_FR.first,
    emits: ['asks', 'placeAsk'],
    expect: { asks: true, postalCode: null, placeAsk: 'coarse' },
    placeOpen: true,
    throughCode: true,
    watchFor: `French, Canada. Right: accepts the no and asks, as the one question, for just the first three characters of their postal code. Wrong: asking for a town or a street. ${NOTHING_NEARBY}`,
    printReply: true,
  },
  {
    id: 'place-decline-2-fr',
    over: DECLINE_FR.second,
    emits: ['asks'],
    expect: { asks: true, postalCode: null, placeDeclined: true },
    throughCode: true,
    watchFor: SECOND_NO_WATCH,
    printReply: true,
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
  // The map (VIL-526): the parent sees only the bubbles the model writes, so
  // each group needs one that code keeps (its own lines' facts, no other group's).
  {
    id: 'find-show-two-groups',
    over: {
      step: 'find_show',
      parentWords: 'Mia is 4 and Leo is 1',
      placeLabel: 'Springfield',
      agesLabel: 'Mia (4) and Leo (1)',
      ageMonths: [48, 12],
      children: [
        { name: 'Mia', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
      ],
      findLines: [SWIM_LINE, STORY_LINE, PLAY_LINE],
      findGroups: [
        { category: 'swimming', lines: [SWIM_LINE] },
        { category: 'free_public', lines: [STORY_LINE, PLAY_LINE] },
      ],
      checklist: { ...DONE_THROUGH_NAME, name: false },
    },
    emits: [],
    expect: {},
    groupBubbles: 2,
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
  placeAsk: (v) => ['full', 'coarse', 'none'].includes(v),
};

/**
 * The fields this fixture needed and the model left out or mistyped. Empty is a pass.
 * `keptGroupBubbles` is how many map bubbles friend-voice kept from this reply.
 */
export function friendMarksMisses(
  fixture,
  value,
  { keptGroupBubbles = 0, judged = null, meaning = null, meaningMin = 4, sent = null } = {},
) {
  const misses = [];
  // Graded on what code sends: speakFriend's refusal and its one rewrite ran on the draw.
  if (fixture.throughCode) {
    if (!sent) misses.push('sent:not_run');
    else if (sent.source === 'unsent') misses.push('sent:unsent');
    // A first no leaves the place open in what is sent; a second no closes it.
    else if (sent.placeDeclined !== !fixture.placeOpen) {
      misses.push(`sent:placeDeclined:${sent.placeDeclined}`);
    }
  }
  // Graded on meaning by the friend-place judge: a low score, or no verdict, is a miss.
  if (fixture.watchFor) {
    if (!meaning) misses.push('meaning:not_judged');
    else if (!(meaning.score >= meaningMin)) {
      misses.push(`meaning:${meaning.score} (${meaning.reason})`);
    }
  }
  // The first no leaves the place open: the coarse code is still to be offered. Through
  // code, what code kept is graded above, not the draw's field.
  if (fixture.placeOpen && !fixture.throughCode && value?.placeDeclined === true) {
    misses.push('placeDeclined:true');
  }
  if (fixture.groupBubbles != null && keptGroupBubbles < fixture.groupBubbles) {
    misses.push(`groupBubbles:${keptGroupBubbles}`);
  }
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
  if (fixture.offersNone) {
    const offered = Array.isArray(value?.connectorsOffered) ? value.connectorsOffered : [];
    if (offered.length > 0) misses.push(`connectorsOffered:${JSON.stringify(offered)}`);
  }
  if (fixture.sendable && judged?.ok !== true) {
    misses.push(`reply:unsendable:${judged?.reason ?? 'not_judged'}`);
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
    const got = value?.[field] ?? null;
    if (got !== want) misses.push(`${field}:${JSON.stringify(got ?? null)}`);
  }
  return misses;
}
