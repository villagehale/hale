/**
 * VIL-360 · the weekday-care ask, one fixture per prompt, plus the named ask in French
 * and in Chinese. Graded on the text a parent would read, after the runtime's own check
 * (readWeekdayAsk in apps/web/lib/channel/nudge/weekday-ask-tools.ts). `language` is the
 * family's language as the runtime passes it; families store en or fr today, so the
 * Chinese fixture tests that the skill writes in whatever language it is handed.
 * Invented names only.
 */

export const WEEKDAY_CARE_ASK_FIXTURES = [
  {
    id: 'after-school-named',
    language: 'en',
    ask: { prompt: 'after_school_named', childId: 'child-1', name: 'Nell' },
    expect: { mentions: ['nell', 'after'] },
  },
  {
    id: 'after-school-named-fr',
    language: 'fr',
    ask: { prompt: 'after_school_named', childId: 'child-1', name: 'Nell' },
    expect: { mentions: ['nell'] },
  },
  {
    id: 'after-school-named-zh',
    language: 'zh',
    ask: { prompt: 'after_school_named', childId: 'child-1', name: 'Nell' },
    expect: { mentions: ['nell'] },
  },
  {
    id: 'after-school-household',
    language: 'en',
    ask: { prompt: 'after_school_household' },
    expect: { mentions: ['after'] },
  },
  {
    id: 'verified-break',
    language: 'en',
    ask: { prompt: 'verified_break', eventKey: 'winter-break-2026-12-21', label: 'winter break' },
    expect: { mentions: ['winter break'] },
  },
  {
    id: 'weekend-fallback',
    language: 'en',
    ask: { prompt: 'weekend_fallback' },
    expect: { mentions: ['weekday'] },
  },
];
