/**
 * VIL-226 · snapshots the proactive decider is graded on.
 * No household names. The school-age weekend is a public shape: an 8-year-old
 * in M2N, Saturday and Sunday morning study blocks, an all-day Saturday
 * commitment, and Toronto Public Library afternoon sessions.
 */

const HOUSE = { areaCoarse: 'M2N', childAgesYears: [8] };

function candidate(over) {
  return {
    id: over.id,
    what: over.what,
    why: over.why,
    sourceUrl: over.sourceUrl ?? null,
    worthlessAfter: over.worthlessAfter ?? null,
    parentRequested: over.parentRequested ?? false,
    dedupeKey: over.id,
  };
}

export const PROACTIVE_DECIDER_FIXTURES = [
  {
    id: 'quiet-parent',
    expect: { actionIn: ['hold', 'drop'], frequency: null },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [],
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      deadlines: [],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'weekend-swim',
          what: 'Saturday drop-in swim',
          why: 'a saved find for an open Saturday',
          sourceUrl: 'https://example.test/swim',
        }),
      ],
      recentSends: [
        { at: '2026-10-02T15:00:00.000Z', replied: false },
        { at: '2026-10-05T15:00:00.000Z', replied: false },
        { at: '2026-10-07T15:00:00.000Z', replied: false },
      ],
      unansweredStreak: 3,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: [],
    },
  },
  {
    id: 'busy-week',
    expect: { action: 'drop', includes: ['market'] },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [
        { day: '2026-10-08', label: 'piano', allDay: false, start: '16:00', end: '18:30' },
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:30' },
        { day: '2026-10-09', label: 'swim practice', allDay: false, start: '16:00', end: '19:30' },
        { day: '2026-10-10', label: 'family visit', allDay: true, start: null, end: null },
        { day: '2026-10-11', label: 'soccer tournament', allDay: true, start: null, end: null },
      ],
      freeWindows: [],
      deadlines: [],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'market',
          what: 'Saturday farmers market',
          why: 'a nearby Saturday listing',
          sourceUrl: 'https://example.test/market',
          worthlessAfter: '2026-10-10T20:00:00.000Z',
        }),
      ],
      recentSends: [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
      unansweredStreak: 0,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: [],
    },
  },
  {
    id: 'requested-watch',
    expect: { action: 'send_now', includes: ['watch-1'] },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [],
      freeWindows: [],
      deadlines: [],
      watches: [{ what: 'the class they asked Hale to re-read' }],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'watch-1',
          what: 'A seat opened in the class you asked me to watch',
          why: 'the parent asked to hear the moment a seat opened',
          sourceUrl: 'https://example.test/class',
          worthlessAfter: '2026-10-08T23:00:00.000Z',
          parentRequested: true,
        }),
      ],
      recentSends: [
        { at: '2026-10-05T15:00:00.000Z', replied: false },
        { at: '2026-10-07T15:00:00.000Z', replied: false },
      ],
      unansweredStreak: 2,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: [],
    },
  },
  {
    id: 'text-me-less',
    expect: { actionIn: ['hold', 'drop'], frequency: 'less' },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [],
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      deadlines: [],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'extra-idea',
          what: 'Sunday craft hour',
          why: 'a saved find',
          sourceUrl: 'https://example.test/craft',
        }),
      ],
      recentSends: [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
      unansweredStreak: 0,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: ['Can you text me less?'],
    },
  },
  {
    id: 'empty-weekend',
    // Same clock as weekend-and-deadline: Thursday 6:00 PM America/Toronto,
    // before quiet hours. Saturday afternoon fits, so this is send_now.
    // Holding until Friday evening is the miss.
    expect: { action: 'send_now', includes: ['sat-find'] },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:00' },
      ],
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      deadlines: [],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'sat-find',
          what: 'Fanous Lantern Craft at Toronto Public Library',
          why: 'Saturday afternoon is open and this session is running',
          sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
      ],
      recentSends: [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
      unansweredStreak: 0,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: [],
    },
  },
  {
    id: 'school-age-weekend',
    expect: { action: 'send_now', includes: ['sun-tpl'], excludes: ['sat-tpl'] },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [
        { day: '2026-10-10', label: 'all-day commitment', allDay: true, start: null, end: null },
        { day: '2026-10-11', label: 'study block', allDay: false, start: '09:00', end: '12:30' },
      ],
      freeWindows: [
        { day: '2026-10-09', start: '09:00', end: '20:00' },
        { day: '2026-10-11', start: '12:30', end: '20:00' },
      ],
      deadlines: [],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'sat-tpl',
          what: 'Fanous Lantern Craft at Toronto Public Library',
          why: 'Saturday at 2:00 p.m., but Saturday is an all-day commitment',
          sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
        candidate({
          id: 'sun-tpl',
          what: 'Family Storytime at Toronto Public Library',
          why: 'Sunday at 2:00 p.m., after the morning study block',
          sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
          worthlessAfter: '2026-10-11T18:00:00.000Z',
        }),
      ],
      recentSends: [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
      unansweredStreak: 0,
      frequencyPreference: null,
      declines: ['indoor playground'],
      recentParentTexts: [],
    },
  },
  {
    id: 'weekend-and-deadline',
    expect: { action: 'send_now', includes: ['sat-find', 'reg-deadline'], exact: true },
    snapshot: {
      timeZone: 'America/Toronto',
      now: '2026-10-08T22:00:00.000Z',
      household: HOUSE,
      calendar: [
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:00' },
      ],
      freeWindows: [{ day: '2026-10-10', start: '13:00', end: '20:00' }],
      deadlines: [{ what: 'Fall swim registration closes Friday', at: '2026-10-09T21:00:00.000Z' }],
      watches: [],
      priorDecisions: [],
      candidates: [
        candidate({
          id: 'sat-find',
          what: 'Fanous Lantern Craft at Toronto Public Library',
          why: 'Saturday afternoon is open and this session is running',
          sourceUrl: 'https://www.torontopubliclibrary.ca/programs-and-classes/',
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
        candidate({
          id: 'reg-deadline',
          what: 'Fall swim registration closes Friday',
          why: 'the window closes this week',
          sourceUrl: 'https://www.toronto.ca/swim-registration',
          worthlessAfter: '2026-10-09T23:00:00.000Z',
        }),
      ],
      recentSends: [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
      unansweredStreak: 0,
      frequencyPreference: null,
      declines: [],
      recentParentTexts: [],
    },
  },
];
