import { describe, expect, it } from 'vitest';
import { ALL_NAV, HISTORY_NAV, PRIMARY_NAV } from './nav';

/**
 * The sidebar and the top header both render navigation off these exports — the
 * dedupe that closed the PM-gate finding where the two lists disagreed on
 * 'history'. These assert the single source's shape so the two consumers can
 * never drift apart again.
 */
describe('shared nav definition', () => {
  it('files history separately from the primary stops', () => {
    expect(PRIMARY_NAV.map((n) => n.href)).not.toContain('/trail');
    expect(HISTORY_NAV.href).toBe('/trail');
    expect(HISTORY_NAV.label).toBe('history');
  });

  it('ALL_NAV is the primary stops followed by history, with no duplicate routes', () => {
    const hrefs = ALL_NAV.map((n) => n.href);
    expect(hrefs).toEqual([...PRIMARY_NAV.map((n) => n.href), '/trail']);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every item carries a non-empty label and an icon (the header eyebrow + sidebar glyph depend on both)', () => {
    for (const item of ALL_NAV) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });
});
