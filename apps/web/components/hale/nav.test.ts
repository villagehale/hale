import { describe, expect, it } from 'vitest';
import { ALL_NAV, HISTORY_NAV, PRIMARY_NAV, RECEIPTS_NAV, SETTINGS_NAV, allNav, primaryNav } from './nav';

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

/**
 * VIL-244 · M9 — the receipts-room reframe (D4/D20). Behind F14_RECEIPTS_IA the app
 * stops being a daily feed and becomes the place a parent checks what Hale did: the
 * five stops are the decision queue, the week, the record, the village and settings.
 * The selectors are pure so BOTH the sidebar and the header eyebrow can be handed the
 * same resolved boolean and never disagree.
 */
describe('receipts-room nav (flag on)', () => {
  it('is exactly Approvals · Week · Trail · Village · Settings, in that order', () => {
    expect(RECEIPTS_NAV.map((n) => n.label)).toEqual([
      'Approvals',
      'Week',
      'Trail',
      'Village',
      'Settings',
    ]);
    expect(RECEIPTS_NAV.map((n) => n.href)).toEqual([
      '/approvals',
      '/plan',
      '/trail',
      '/village',
      '/settings',
    ]);
  });

  it('demotes the daily feed and hides the Ask chat: neither route is a stop', () => {
    const hrefs = RECEIPTS_NAV.map((n) => n.href);
    expect(hrefs).not.toContain('/home');
    expect(hrefs).not.toContain('/coach');
  });

  it('gives every stop a distinct glyph (an aliased icon would render two stops identically)', () => {
    const icons = RECEIPTS_NAV.map((n) => n.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('primaryNav returns today IA when off and the receipts stops when on', () => {
    expect(primaryNav(false)).toEqual(PRIMARY_NAV);
    expect(primaryNav(true)).toEqual(RECEIPTS_NAV);
  });

  it('allNav keeps the eyebrow honest: the receipts stops first, then the demoted-but-reachable routes', () => {
    expect(allNav(false)).toEqual(ALL_NAV);
    const on = allNav(true);
    // The five stops lead, so a shared route (/village, /settings) resolves to its
    // receipts label rather than the old one.
    expect(on.slice(0, RECEIPTS_NAV.length)).toEqual([...RECEIPTS_NAV]);
    // A route that is no longer a stop but is still reachable by direct URL keeps a
    // label, so its page does not lose the running-head eyebrow.
    expect(on.map((n) => n.href)).toContain('/coach');
    expect(on.map((n) => n.href)).toContain('/companion');
    expect(on.map((n) => n.href)).toContain('/family');
    const hrefs = on.map((n) => n.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
