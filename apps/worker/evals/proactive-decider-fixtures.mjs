/**
 * VIL-226 · snapshots the proactive decider is graded on. Invented households, places
 * and links only. Every fixture reads at Thursday 6:00 PM in the family's own zone,
 * which the runner renders into `localNow` exactly as the runtime does.
 *
 * The keys follow loadFamilySnapshot's order (apps/web/lib/channel/proactive/snapshot.ts)
 * so the model reads the same JSON shape production sends. A candidate is its kind and a
 * names-free label (`why`), never the composed text: that is the writer's input.
 */

const TZ = 'America/New_York';
const THURSDAY_EVENING = '2026-10-08T22:00:00.000Z';
const HOUSE = { areaCoarse: null, childAgesYears: [8] };
const LIBRARY = 'https://library.example.test/programs';

function candidate(over) {
  return {
    id: over.id,
    kind: 'nudge',
    why: over.why,
    sourceUrl: over.sourceUrl ?? null,
    worthlessAfter: over.worthlessAfter ?? null,
    parentRequested: over.parentRequested ?? false,
  };
}

function snapshot(over) {
  return {
    timeZone: TZ,
    now: THURSDAY_EVENING,
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
];
