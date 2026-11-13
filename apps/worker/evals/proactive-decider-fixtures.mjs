/**
 * VIL-226 · snapshots the proactive decider is graded on. Invented households, places
 * and links only. Every fixture reads at Thursday 6:00 PM in the family's own zone
 * unless it names another clock (the VIL-681 check-backs read in the morning and at
 * midday), which the runner renders into `localNow` exactly as the runtime does.
 *
 * The keys follow loadFamilySnapshot's order (apps/web/lib/channel/proactive/snapshot.ts)
 * so the model reads the same JSON shape production sends. A candidate is its kind and a
 * names-free label (`why`), never the composed text: that is the writer's input.
 */

const TZ = 'America/New_York';
const THURSDAY_EVENING = '2026-10-08T22:00:00.000Z';
const HOUSE = { areaCoarse: null, childAgesYears: [8] };
const LIBRARY = 'https://library.example.test/programs';
/** VIL-681 · Thursday 8:23 AM and 11:00 AM local: the review after the sweep queued it. */
const THURSDAY_FIRST_THING = '2026-10-08T12:23:00.000Z';
const THURSDAY_MIDDAY = '2026-10-08T15:00:00.000Z';
/** The check-back's one day closes Friday 8:00 AM local. */
const CHECKBACK = {
  id: 'checkback',
  kind: 'next_day_checkback',
  why: 'next_day_checkback asked=2026-10-08T01:40:00.000Z',
  worthlessAfter: '2026-10-09T12:00:00.000Z',
};
/** A week of home calendar with no free window in it. */
const FULL_WEEK = [
  { day: '2026-10-08', label: 'piano', allDay: false, start: '16:00', end: '18:30' },
  { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:30' },
  { day: '2026-10-09', label: 'swim practice', allDay: false, start: '16:00', end: '19:30' },
  { day: '2026-10-10', label: 'family visit', allDay: true, start: null, end: null },
  { day: '2026-10-11', label: 'soccer tournament', allDay: true, start: null, end: null },
];
/** Three texts in a row with no reply. */
const UNANSWERED = [
  { at: '2026-10-02T15:00:00.000Z', replied: false },
  { at: '2026-10-05T15:00:00.000Z', replied: false },
  { at: '2026-10-07T15:00:00.000Z', replied: false },
];

function candidate(over) {
  return {
    id: over.id,
    kind: over.kind ?? 'nudge',
    why: over.why,
    sourceUrl: over.sourceUrl ?? null,
    worthlessAfter: over.worthlessAfter ?? null,
    parentRequested: over.parentRequested ?? false,
  };
}

function snapshot(over) {
  return {
    timeZone: TZ,
    now: over.now ?? THURSDAY_EVENING,
    household: HOUSE,
    calendar: over.calendar ?? [],
    freeWindows: over.freeWindows ?? [],
    deadlines: over.deadlines ?? [],
    watches: over.watches ?? [],
    candidates: over.candidates,
    recentSends: over.recentSends ?? [{ at: '2026-10-06T15:00:00.000Z', replied: true }],
    unansweredStreak: over.unansweredStreak ?? 0,
    frequencyPreference: null,
    declines: over.declines ?? [],
    recentParentTexts: over.recentParentTexts ?? [],
    priorDecisions: [],
  };
}

export const PROACTIVE_DECIDER_FIXTURES = [
  {
    id: 'quiet-parent',
    expect: { actionIn: ['hold', 'drop'], frequency: null },
    snapshot: snapshot({
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      candidates: [
        candidate({
          id: 'weekend-swim',
          why: 'a saved find for an open Saturday',
          sourceUrl: 'https://pool.example.test/swim',
        }),
      ],
      recentSends: [
        { at: '2026-10-02T15:00:00.000Z', replied: false },
        { at: '2026-10-05T15:00:00.000Z', replied: false },
        { at: '2026-10-07T15:00:00.000Z', replied: false },
      ],
      unansweredStreak: 3,
    }),
  },
  {
    id: 'busy-week',
    expect: { action: 'drop', includes: ['market'] },
    snapshot: snapshot({
      calendar: [
        { day: '2026-10-08', label: 'piano', allDay: false, start: '16:00', end: '18:30' },
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:30' },
        { day: '2026-10-09', label: 'swim practice', allDay: false, start: '16:00', end: '19:30' },
        { day: '2026-10-10', label: 'family visit', allDay: true, start: null, end: null },
        { day: '2026-10-11', label: 'soccer tournament', allDay: true, start: null, end: null },
      ],
      candidates: [
        candidate({
          id: 'market',
          why: 'a nearby Saturday listing',
          sourceUrl: 'https://market.example.test/saturday',
          worthlessAfter: '2026-10-10T20:00:00.000Z',
        }),
      ],
    }),
  },
  {
    id: 'requested-watch',
    expect: { action: 'send_now', includes: ['watch-1'] },
    snapshot: snapshot({
      watches: [{ what: 'the class they asked Hale to re-read' }],
      candidates: [
        candidate({
          id: 'watch-1',
          why: 'the parent asked to hear the moment a seat opened',
          sourceUrl: 'https://rec.example.test/class',
          worthlessAfter: '2026-10-08T23:00:00.000Z',
          parentRequested: true,
        }),
      ],
      recentSends: [
        { at: '2026-10-05T15:00:00.000Z', replied: false },
        { at: '2026-10-07T15:00:00.000Z', replied: false },
      ],
      unansweredStreak: 2,
    }),
  },
  {
    id: 'text-me-less',
    expect: { actionIn: ['hold', 'drop'], frequency: 'less' },
    snapshot: snapshot({
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      candidates: [
        candidate({
          id: 'extra-idea',
          why: 'a saved find',
          sourceUrl: 'https://library.example.test/craft',
        }),
      ],
      recentParentTexts: ['Can you text me less?'],
    }),
  },
  {
    id: 'empty-weekend',
    // Thursday 6:00 PM local, before quiet hours, and Saturday afternoon fits: send
    // now. Holding until Friday evening is the miss this fixture exists for.
    expect: { action: 'send_now', includes: ['sat-find'] },
    snapshot: snapshot({
      calendar: [
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:00' },
      ],
      freeWindows: [{ day: '2026-10-10', start: '09:00', end: '20:00' }],
      candidates: [
        candidate({
          id: 'sat-find',
          why: 'Saturday afternoon is open and this session is running',
          sourceUrl: LIBRARY,
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
      ],
    }),
  },
  {
    id: 'school-age-weekend',
    expect: { action: 'send_now', includes: ['sun-lib'], excludes: ['sat-lib'] },
    snapshot: snapshot({
      calendar: [
        { day: '2026-10-10', label: 'all-day commitment', allDay: true, start: null, end: null },
        { day: '2026-10-11', label: 'study block', allDay: false, start: '09:00', end: '12:30' },
      ],
      freeWindows: [
        { day: '2026-10-09', start: '09:00', end: '20:00' },
        { day: '2026-10-11', start: '12:30', end: '20:00' },
      ],
      candidates: [
        candidate({
          id: 'sat-lib',
          why: 'Saturday at 2:00 p.m., but Saturday is an all-day commitment',
          sourceUrl: LIBRARY,
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
        candidate({
          id: 'sun-lib',
          why: 'Sunday at 2:00 p.m., after the morning study block',
          sourceUrl: LIBRARY,
          worthlessAfter: '2026-10-11T18:00:00.000Z',
        }),
      ],
      declines: ['indoor playground'],
    }),
  },
  {
    id: 'weekend-and-deadline',
    expect: { action: 'send_now', includes: ['sat-find', 'reg-deadline'], exact: true },
    snapshot: snapshot({
      calendar: [
        { day: '2026-10-09', label: 'school', allDay: false, start: '09:00', end: '15:00' },
      ],
      freeWindows: [{ day: '2026-10-10', start: '13:00', end: '20:00' }],
      deadlines: [{ what: 'Fall swim registration closes Friday', at: '2026-10-09T21:00:00.000Z' }],
      candidates: [
        candidate({
          id: 'sat-find',
          why: 'Saturday afternoon is open and this session is running',
          sourceUrl: LIBRARY,
          worthlessAfter: '2026-10-10T18:00:00.000Z',
        }),
        candidate({
          id: 'reg-deadline',
          why: 'the window closes this week',
          sourceUrl: 'https://rec.example.test/swim-registration',
          worthlessAfter: '2026-10-09T23:00:00.000Z',
        }),
      ],
    }),
  },
  // VIL-612 · kinds that are news about the family, as their sweeps queue them: the
  // `why` is the class code the sweep writes, never the composed text.
  {
    id: 'coparent-left-quiet-parent',
    expect: { action: 'send_now', includes: ['departed'], frequency: null },
    snapshot: snapshot({
      candidates: [
        candidate({ id: 'departed', kind: 'co_parent_departed', why: 'co_parent_departed' }),
      ],
      recentSends: UNANSWERED,
      unansweredStreak: 3,
    }),
  },
  {
    id: 'travel-brief-busy-home',
    expect: { action: 'send_now', includes: ['trip'] },
    snapshot: snapshot({
      calendar: FULL_WEEK,
      candidates: [
        candidate({
          id: 'trip',
          kind: 'travel_brief',
          why: 'travel_brief',
          worthlessAfter: '2026-10-15T04:00:00.000Z',
        }),
      ],
    }),
  },
  {
    id: 'coparent-left-beside-busy-find',
    expect: { action: 'send_now', includes: ['departed'], excludes: ['market'] },
    snapshot: snapshot({
      calendar: FULL_WEEK,
      candidates: [
        candidate({ id: 'departed', kind: 'co_parent_departed', why: 'co_parent_departed' }),
        candidate({
          id: 'market',
          why: 'a nearby Saturday listing',
          sourceUrl: 'https://market.example.test/saturday',
          worthlessAfter: '2026-10-10T20:00:00.000Z',
        }),
      ],
    }),
  },
  // VIL-681 · a parent started something yesterday and went quiet. The `why` is the
  // sweep's names-free label, never the thread's title.
  {
    id: 'checkback-first-thing',
    // The sweep queues it as the day opens; the decider waits for later in their day.
    expect: { action: 'hold', includes: ['checkback'], frequency: null },
    snapshot: snapshot({ now: THURSDAY_FIRST_THING, candidates: [candidate(CHECKBACK)] }),
  },
  {
    id: 'checkback-midday',
    expect: { action: 'send_now', includes: ['checkback'], frequency: null },
    snapshot: snapshot({ now: THURSDAY_MIDDAY, candidates: [candidate(CHECKBACK)] }),
  },
  {
    // VIL-685 · no page has this family's winter break, so the one question: it may go now
    // or wait for a better moment before mid-December, but never be thrown away.
    id: 'school-break-ask',
    expect: { actionIn: ['send_now', 'hold'], includes: ['break-ask'], frequency: null },
    snapshot: snapshot({
      now: THURSDAY_MIDDAY,
      candidates: [
        candidate({
          id: 'break-ask',
          kind: 'school_break_ask',
          why: 'school_break_ask year=2026-27',
          worthlessAfter: '2026-12-15T17:00:00.000Z',
        }),
      ],
    }),
  },
  {
    // VIL-685 · the break question, once the board's page gave the dates: a nudge the
    // nudge sweep handed off. Never thrown away; the moment is the decider's.
    id: 'winter-break-question',
    expect: { actionIn: ['send_now', 'hold'], includes: ['winter-break'], frequency: null },
    snapshot: snapshot({
      now: THURSDAY_MIDDAY,
      candidates: [
        candidate({
          id: 'winter-break',
          why: 'weekday_care',
          worthlessAfter: '2026-12-21T05:00:00.000Z',
        }),
      ],
    }),
  },
];
