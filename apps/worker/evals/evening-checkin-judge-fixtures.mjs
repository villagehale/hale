/**
 * Judge-only fixtures for the evening check-in.
 *
 * Two judgments, both the existing proactive decider's (proactive-decider.md).
 * The model reads cadence from any wording, in any language. The model also
 * chooses whether and when to check in. These fixtures are graded by a person.
 * They are not imported by a runner, not listed in package.json, and not a CI
 * step. Running them would be a paid model call, which this change does not do.
 *
 * Do not add an expected sentence. The writer speaks. A fixture that locked the
 * text would be the fixed copy this lane just deleted.
 */

const TZ = 'America/Toronto';
const EVENING = '2026-07-06T00:17:00.000Z';

function checkIn(over = {}) {
  return {
    id: over.id ?? 'evening',
    kind: 'evening_check_in',
    why: 'evening check-in',
    sourceUrl: null,
    worthlessAfter: '2026-07-06T12:00:00.000Z',
    parentRequested: false,
  };
}

function snapshot(over) {
  return {
    timeZone: TZ,
    now: EVENING,
    household: { areaCoarse: null, childAgesYears: [4] },
    calendar: over.calendar ?? [
      { day: '2026-07-05', label: 'swim', allDay: false, start: '16:00', end: '17:00' },
    ],
    freeWindows: [],
    deadlines: [],
    watches: [],
    candidates: over.candidates ?? [checkIn()],
    recentSends: over.recentSends ?? [],
    unansweredStreak: over.unansweredStreak ?? 0,
    frequencyPreference: over.frequencyPreference ?? null,
    declines: [],
    recentParentTexts: over.recentParentTexts ?? [],
    priorDecisions: [],
  };
}

export const EVENING_CHECKIN_JUDGE_FIXTURES = [
  {
    id: 'pace-en-less',
    judges: 'cadence_intent',
    parentText: 'text me less',
    expect: { frequencyDirection: 'less' },
  },
  {
    id: 'pace-zh-more',
    judges: 'cadence_intent',
    parentText: '每天提醒我',
    expect: { frequencyDirection: 'more' },
  },
  {
    id: 'pace-fr-more',
    judges: 'cadence_intent',
    parentText: 'plus souvent stp',
    expect: { frequencyDirection: 'more' },
  },
  {
    id: 'pace-ar-less',
    judges: 'cadence_intent',
    parentText: 'راسلني أقل من فضلك',
    expect: { frequencyDirection: 'less' },
  },
  {
    id: 'check-in-send',
    judges: 'check_in_decision',
    expect: { action: 'send_now', itemIds: ['evening'] },
    snapshot: snapshot({ recentParentTexts: [] }),
  },
  {
    id: 'check-in-hold-after-less',
    judges: 'check_in_decision',
    expect: { actionIn: ['hold', 'drop'], frequencyDirection: 'less' },
    snapshot: snapshot({
      recentParentTexts: ['text me less'],
      recentSends: [{ at: '2026-07-05T00:17:00.000Z', replied: true }],
    }),
  },
  {
    id: 'check-in-zh-more',
    judges: 'check_in_decision',
    expect: { action: 'send_now', frequencyDirection: 'more' },
    snapshot: snapshot({ recentParentTexts: ['每天提醒我'] }),
  },
  {
    id: 'check-in-ar-less',
    judges: 'check_in_decision',
    expect: { actionIn: ['hold', 'drop'], frequencyDirection: 'less' },
    snapshot: snapshot({
      recentParentTexts: ['راسلني أقل من فضلك'],
      unansweredStreak: 2,
    }),
  },
];
