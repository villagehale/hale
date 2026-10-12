/**
 * VIL-360 · the weekday-care ask, one fixture per prompt. Graded on the text a parent
 * would read, after the runtime's own check (readWeekdayAsk in apps/web/lib/channel/
 * nudge/weekday-ask-tools.ts). Invented names only.
 */

export const WEEKDAY_CARE_ASK_FIXTURES = [
  {
    id: 'after-school-named',
    ask: { prompt: 'after_school_named', childId: 'child-1', name: 'Nell' },
    expect: { mentions: ['nell', 'after'] },
  },
  {
    id: 'after-school-household',
    ask: { prompt: 'after_school_household' },
    expect: { mentions: ['after'] },
  },
  {
    id: 'verified-break',
    ask: { prompt: 'verified_break', eventKey: 'winter-break-2026-12-21', label: 'winter break' },
    expect: { mentions: ['winter break'] },
  },
  {
    id: 'weekend-fallback',
    ask: { prompt: 'weekend_fallback' },
    expect: { mentions: ['weekday'] },
  },
];
