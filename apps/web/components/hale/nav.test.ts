import { describe, expect, it } from 'vitest';
import { ALL_NAV, HISTORY_NAV, PRIMARY_NAV, SETTINGS_NAV } from './nav';

/**
 * The sidebar and the top header both render navigation off these exports — the
 * dedupe that closed the PM-gate finding where the two lists disagreed on
 * 'history'. These assert the single source's shape so the two consumers can
 * never drift apart again.
 */
describe('shared nav definition', () => {
  it('files history and settings separately from the primary stops', () => {
    expect(PRIMARY_NAV.map((n) => n.href)).not.toContain('/trail');
    expect(PRIMARY_NAV.map((n) => n.href)).not.toContain('/settings');
    expect(HISTORY_NAV.href).toBe('/trail');
    expect(HISTORY_NAV.label).toBe('history');
    expect(SETTINGS_NAV.href).toBe('/settings');
    expect(SETTINGS_NAV.label).toBe('account');
  });

  it('the primary stops are the daily product surfaces, with family pointing at /family (not settings)', () => {
    const family = PRIMARY_NAV.find((n) => n.label === 'Family');
    expect(family?.href).toBe('/family');
  });

  it('carries the design-handoff labels: Home, Companion, Ask, Village, Family — Ask points at the existing /coach route', () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      'Home',
      'Companion',
      'Ask',
      'Village',
      'Family',
    ]);
    const ask = PRIMARY_NAV.find((n) => n.label === 'Ask');
    expect(ask?.href).toBe('/coach');
  });

  it('ALL_NAV is the primary stops followed by settings, with history filed separately (retired from the sidebar) and no duplicate routes', () => {
    const hrefs = ALL_NAV.map((n) => n.href);
    expect(hrefs).toEqual([...PRIMARY_NAV.map((n) => n.href), '/settings']);
    expect(hrefs).not.toContain('/trail');
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every item carries a non-empty label and an icon (the header eyebrow + sidebar glyph depend on both)', () => {
    for (const item of ALL_NAV) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });

  it('every nav glyph is a distinct icon (lucide aliases like Home===House render identically, so the sidebar must not reuse one)', () => {
    const icons = ALL_NAV.map((n) => n.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
