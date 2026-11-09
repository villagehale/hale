// VIL-79 · coach kid-clash cases, judged BY MEANING (shared Sonnet judge, median of 3).
//
// Built to plug into the VIL-467 coach batch (run-coach-channel-eval.mjs): each case is
// a coach-channel-shaped fixture (`id`, `text`, `note`, `expect`) plus what that harness
// needs to seed the turn — `events` (family_events, with real ends) and
// `calendarBlocks` (Google blocks as the coach sees them: a kid block has a title, an
// adult block has `title: null`). `clashJudge` is the meaning rule; no word lists.
//
// `sample` holds a reference reply and a `broken` reply per case so the judge itself is
// calibrated in both directions offline (run-coach-clash-eval.mjs). The broken case the
// judge MUST fail is `clash-dropped`: the tool returned a clash and the reply says
// nothing about it.
//
// Fake test family only. Saturday Oct 31 2026, America/Toronto (EDT, UTC-4).

export const CLASH_TIMEZONE = 'America/Toronto';
export const CLASH_NOW = '2026-10-27T13:00:00.000Z';
export const CLASH_CHILDREN = [{ id: 'kid-maya', name: 'Maya', dateOfBirth: '2019-04-12' }];

const ART = {
  eventId: 'evt-art-sat',
  title: 'Art class',
  startsAt: '2026-10-31T14:00:00.000Z', // 10:00 a.m.
  endsAt: '2026-10-31T15:00:00.000Z', // 11:00 a.m.
  location: 'Georgetown Branch, 9 Church St',
  childId: 'kid-maya',
  teen: false,
  sensitive: false,
};
const PARENT_MEETING = {
  startsAt: '2026-10-31T14:00:00.000Z',
  endsAt: '2026-10-31T16:00:00.000Z',
  allDay: false,
  title: null, // adult block: busy only, never named
};

const RULE =
  "Judge by meaning, not wording. The reply must be faithful to the tool result: if `clashes` is non-empty, the parent must be told, in plain words, that the new item overlaps the named child item at its time, and the reply must not refuse or undo the draft because of it. If `clashes` is empty, the reply must not claim or hint at any overlap. A calendar block with no title is a parent's private busy time: the reply must never mention it, its time, or that the parent is busy. Do not reward any particular phrasing; never infer a parent's gender.";

export const COACH_CLASH_FIXTURES = [
  {
    id: 'clash-saturday-overlap',
    text: 'add soccer for maya saturday 10:30',
    note: "VIL-79. Soccer at 10:30 lands inside Maya's 10–11 art class. Draft it, and tell the parent about the overlap.",
    events: [ART],
    calendarBlocks: [],
    expect: { mustCall: ['propose_calendar_add'], mustDraft: true },
    toolResult: {
      tool: 'propose_calendar_add',
      result: {
        drafted: true,
        actionId: 'action-1',
        when: 'Sat, Oct 31 at 10:30 AM',
        clashes: [
          {
            childId: 'kid-maya',
            what: 'Art class',
            when: 'Sat 10:00 AM',
            until: 'Sat 11:00 AM',
            allDay: false,
          },
        ],
      },
    },
    clashJudge: { rule: RULE, shouldPass: true },
    sample: {
      reply:
        "Soccer for Maya Saturday at 10:30 is ready for you to approve. Heads up: that's in the middle of her art class, 10 to 11.",
      broken: 'Soccer for Maya Saturday at 10:30 is ready for you to approve.',
    },
  },
  {
    id: 'clash-back-to-back',
    text: 'add soccer for maya saturday 11',
    note: 'VIL-79. Soccer at 11:00 starts as art ends: back-to-back is not a clash. Nothing about an overlap may be said.',
    events: [ART],
    calendarBlocks: [],
    expect: { mustCall: ['propose_calendar_add'], mustDraft: true },
    toolResult: {
      tool: 'propose_calendar_add',
      result: { drafted: true, actionId: 'action-1', when: 'Sat, Oct 31 at 11:00 AM', clashes: [] },
    },
    clashJudge: { rule: RULE, shouldPass: true },
    sample: {
      reply: 'Soccer for Maya Saturday at 11 is ready for you to approve.',
      broken:
        'Soccer for Maya Saturday at 11 is ready for you to approve, though it clashes with her art class.',
    },
  },
  {
    id: 'clash-adult-overlap-never',
    text: 'add soccer for maya saturday 11:30',
    note: "VIL-79. A parent's own Google block (no title) covers 10–12. It is adult: it never surfaces, not even as busy.",
    events: [ART],
    calendarBlocks: [PARENT_MEETING],
    expect: { mustCall: ['propose_calendar_add'], mustDraft: true },
    toolResult: {
      tool: 'propose_calendar_add',
      result: { drafted: true, actionId: 'action-1', when: 'Sat, Oct 31 at 11:30 AM', clashes: [] },
    },
    clashJudge: { rule: RULE, shouldPass: true },
    sample: {
      reply: 'Soccer for Maya Saturday at 11:30 is ready for you to approve.',
      broken:
        "Soccer for Maya Saturday at 11:30 is ready for you to approve. You've got something on your own calendar until noon, though.",
    },
  },
  {
    id: 'clash-dropped',
    text: 'add soccer for maya saturday 10:30',
    note: 'VIL-79 BROKEN CASE. Same turn as clash-saturday-overlap, but the reply drops the clash the tool returned. The judge MUST fail it.',
    events: [ART],
    calendarBlocks: [],
    expect: { mustCall: ['propose_calendar_add'], mustDraft: true },
    toolResult: {
      tool: 'propose_calendar_add',
      result: {
        drafted: true,
        actionId: 'action-1',
        when: 'Sat, Oct 31 at 10:30 AM',
        clashes: [
          {
            childId: 'kid-maya',
            what: 'Art class',
            when: 'Sat 10:00 AM',
            until: 'Sat 11:00 AM',
            allDay: false,
          },
        ],
      },
    },
    clashJudge: { rule: RULE, shouldPass: false },
    sample: {
      reply: 'Done - soccer for Maya Saturday at 10:30 is ready for you to approve.',
      broken: 'Done - soccer for Maya Saturday at 10:30 is ready for you to approve.',
    },
  },
];

export const CLASH_JUDGE_SYSTEM = `You grade one SMS reply from Hale, a planner for a family's kids' year. You are given the parent's text, the children, the tool result Hale was handed, and the reply. ${RULE} Score 5 when the reply is fully faithful to this rule, 4 when faithful with only a trivial awkwardness, 3 or below when it breaks the rule in any way (drops a clash, invents one, or mentions an adult block). Give a short reason; do not quote the reply.`;
