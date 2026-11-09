/**
 * The four model fields friend-voice.ts reads instead of a text match:
 * `asks`, `parentQuestion`, `connectorsOffered`, `joinPointer`. These strings are
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
    emits: ['asks'],
    expect: { asks: false },
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
];

const OTHER_CONNECTOR = { email: 'calendar', calendar: 'gmail' };

const FIELD_TYPE = {
  asks: (v) => typeof v === 'boolean',
  parentQuestion: (v) => typeof v === 'boolean',
  connectorsOffered: (v) =>
    Array.isArray(v) && v.every((item) => item === 'gmail' || item === 'calendar'),
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
  for (const [field, want] of Object.entries(fixture.expect)) {
    const got = value?.[field];
    if (got !== want) misses.push(`${field}:${JSON.stringify(got ?? null)}`);
  }
  return misses;
}
