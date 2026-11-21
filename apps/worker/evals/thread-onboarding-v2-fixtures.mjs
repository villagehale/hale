/**
 * VIL-721 · the in-thread onboarding walk, lit (THREAD_ONBOARDING_V2_ENABLED=true).
 *
 * These strings are the cases, not a matcher: code never decides intent from them.
 * Each fixture is one onboarding turn the production friend voice writes, graded on
 * the fields friend-voice.ts reads and on whether code would send the reply:
 *
 * - `activities` turns: the model asks what the kids already do (one question), and
 *   reads the answer into `activities` (one entry per thing, the kid when said, the
 *   parent's own words), or `activitiesNone` for none / rather not, in any language.
 * - `google` turns: ONE link connects Gmail and Google Calendar. The ask lists both in
 *   `connectorsOffered`, carries Google's unverified-app screen as a heads-up from
 *   `facts.googleLink`, and passes the production judge with the link following it.
 *   A yes is `connectGoogle` true with `parentQuestion` false; a question is not a yes.
 * - `connected` with connector `google`: the wow line names one real synced item.
 *
 * `expect` names exact field values; `activityWords` are substrings an extracted
 * activity must carry (the parent's own words); `sendable` means the reply must pass
 * `judgeFriendReply` for its step with the link the turn carries; `convey` lists fact
 * tokens the reply must carry verbatim (Google's own UI labels, which stay as Google
 * writes them); `throughCode` grades what speakFriend would send.
 */

const DONE_THROUGH_AGES = {
  postal: true,
  kids: true,
  ages: true,
  activities: false,
  name: false,
  gmail: false,
  calendar: false,
  google: false,
  schedule: false,
  coparent: false,
};
const DONE_THROUGH_NAME = { ...DONE_THROUGH_AGES, activities: true, name: true };
const DONE_THROUGH_GOOGLE = { ...DONE_THROUGH_NAME, google: true };

const MAYA = [{ name: 'Maya', ageMonths: 72 }];
const MAYA_LEO = [
  { name: 'Maya', ageMonths: 72 },
  { name: 'Leo', ageMonths: 48 },
];
const MAP_LINES = [
  'Swim at the rec centre (ages 6-8) - Saturdays 10:00',
  'Story time - Tuesdays 10:30',
];
const MAP_TURN = {
  role: 'hale',
  body: 'Here is what is on near you for their ages.',
};

const GOOGLE_ASK = {
  role: 'hale',
  body: 'Google shows its own "unverified app" screen first: tap Advanced, then continue. Want me to connect Gmail and your calendar with this link?',
  asked: true,
};

export const THREAD_V2_FIXTURES = [
  {
    id: 'activities-ask',
    over: {
      step: 'activities',
      parentWords: "she's 6",
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      findLines: MAP_LINES,
      checklist: DONE_THROUGH_AGES,
      kidActivities: [],
      recentTurns: [MAP_TURN],
    },
    expect: { asks: true },
    offersNone: true,
    sendable: true,
  },
  {
    id: 'activities-answer-two-kids',
    over: {
      step: 'activities',
      parentWords: 'Maya does swim lessons on Saturdays and Leo just started soccer',
      children: MAYA_LEO,
      ageMonths: [72, 48],
      agesLabel: 'Maya, 6 and Leo, 4',
      placeLabel: 'Toronto',
      checklist: DONE_THROUGH_AGES,
      kidActivities: [],
      recentTurns: [
        MAP_TURN,
        {
          role: 'hale',
          body: 'What do Maya and Leo already do, like a class or a sport?',
          asked: true,
        },
      ],
    },
    activityWords: [
      { child: 'Maya', words: 'swim' },
      { child: 'Leo', words: 'soccer' },
    ],
    expect: { asks: true },
    sendable: true,
  },
  {
    id: 'activities-none',
    over: {
      step: 'activities',
      parentWords: "nothing yet, she's still little",
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      checklist: DONE_THROUGH_AGES,
      kidActivities: [],
      recentTurns: [
        MAP_TURN,
        { role: 'hale', body: 'What does Maya already do, like a class or a sport?', asked: true },
      ],
    },
    expect: { activitiesNone: true, asks: true },
    noActivities: true,
    sendable: true,
  },
  {
    id: 'activities-answer-fr',
    over: {
      step: 'activities',
      language: 'fr',
      parentWords: 'Maya fait de la natation le samedi',
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6 ans',
      placeLabel: 'Montréal',
      checklist: DONE_THROUGH_AGES,
      kidActivities: [],
      recentTurns: [
        {
          role: 'hale',
          body: 'Maya fait déjà des activités, comme un cours ou un sport?',
          asked: true,
        },
      ],
    },
    activityWords: [{ child: 'Maya', words: 'natation' }],
    expect: { asks: true },
    sendable: true,
  },
  {
    id: 'google-ask',
    over: {
      step: 'google',
      parentWords: 'Dana',
      parentName: 'Dana',
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      checklist: { ...DONE_THROUGH_NAME, name: true },
      kidActivities: [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }],
      recentTurns: [{ role: 'hale', body: 'What should I call you?', asked: true }],
    },
    linkFollows: true,
    offersBoth: true,
    convey: ['Advanced'],
    expect: { asks: true },
    sendable: true,
  },
  {
    id: 'google-yes',
    over: {
      step: 'google',
      parentWords: 'yes please',
      parentName: 'Dana',
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      checklist: DONE_THROUGH_NAME,
      kidActivities: [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }],
      recentTurns: [GOOGLE_ASK],
    },
    linkAbove: true,
    offersBoth: true,
    expect: { connectGoogle: true, parentQuestion: false, asks: false },
    sendable: true,
  },
  {
    id: 'google-question',
    over: {
      step: 'google',
      parentWords: 'wait, does it read my work email too?',
      parentName: 'Dana',
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      checklist: DONE_THROUGH_NAME,
      kidActivities: [],
      recentTurns: [GOOGLE_ASK],
    },
    linkAbove: true,
    noYes: true,
    expect: { parentQuestion: true, asks: true },
    sendable: true,
  },
  {
    id: 'connected-google',
    over: {
      step: 'connected',
      parentWords: '',
      parentName: 'Dana',
      connector: 'google',
      children: MAYA,
      ageMonths: [72],
      agesLabel: 'Maya, 6',
      placeLabel: 'Toronto',
      checklist: DONE_THROUGH_GOOGLE,
      kidActivities: [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }],
      timeZone: 'America/Toronto',
      synced: {
        provider: 'google',
        read: 'ok',
        calendar: [
          {
            title: 'Maya swim lesson',
            start: '2026-08-01T14:00:00.000Z',
            end: '2026-08-01T14:45:00.000Z',
            allDay: false,
            location: 'Rec centre pool',
            declined: false,
          },
        ],
        email: [
          {
            subject: 'Grade 1 class trip form due Friday',
            fromName: 'Maya school office',
            receivedAt: '2026-07-29T15:00:00.000Z',
            snippet: 'Please return the signed trip form by Friday.',
          },
        ],
        overlaps: [],
      },
    },
    mentions: true,
    expect: { asks: false },
    sendable: true,
  },
];

const FIELD_TYPE = {
  asks: (value) => typeof value === 'boolean',
  parentQuestion: (value) => typeof value === 'boolean',
  connectGoogle: (value) => value === true || value === false,
  activitiesNone: (value) => typeof value === 'boolean',
};

/** What a draw got wrong for this fixture, as short codes. Empty is a pass. */
export function threadV2Misses(fixture, value, { judged = null } = {}) {
  const misses = [];
  if (!value) return ['value:none'];
  for (const [field, want] of Object.entries(fixture.expect ?? {})) {
    if (!(field in value) || !FIELD_TYPE[field]?.(value[field])) misses.push(`${field}:omitted`);
    else if (value[field] !== want) misses.push(`${field}:${JSON.stringify(value[field])}`);
  }
  const offered = Array.isArray(value.connectorsOffered) ? value.connectorsOffered : [];
  if (fixture.offersBoth && !(offered.includes('gmail') && offered.includes('calendar'))) {
    misses.push(`connectorsOffered:${JSON.stringify(offered)}`);
  }
  if (fixture.offersNone && offered.length > 0) {
    misses.push(`connectorsOffered:${JSON.stringify(offered)}`);
  }
  const activities = Array.isArray(value.activities) ? value.activities : [];
  for (const { child, words } of fixture.activityWords ?? []) {
    const found = activities.some(
      (item) =>
        typeof item?.activity === 'string' &&
        item.activity.toLowerCase().includes(words) &&
        (child == null || item.child === child),
    );
    if (!found) misses.push(`activities:missing:${child}:${words}`);
  }
  if (fixture.noActivities && activities.length > 0) misses.push('activities:kept');
  if (fixture.noYes && value.connectGoogle === true) misses.push('connectGoogle:yes_kept');
  for (const token of fixture.convey ?? []) {
    if (!String(value.reply ?? '').includes(token)) misses.push(`convey:${token}`);
  }
  if (fixture.mentions && !(typeof value.ahaMention === 'string' && value.ahaMention.length > 0)) {
    misses.push('ahaMention:none');
  }
  if (fixture.sendable && judged?.ok !== true) {
    misses.push(`reply:unsendable:${judged?.reason ?? 'not_judged'}`);
  }
  return misses;
}
