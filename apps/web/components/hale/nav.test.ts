import { describe, expect, it } from 'vitest';
import {
  ALL_NAV,
  DEMOTED_NAV,
  HISTORY_NAV,
  PRIMARY_NAV,
  RECEIPTS_NAV,
  SETTINGS_NAV,
  allNav,
  primaryNav,
} from './nav';

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

  it('carries no stop for a retired surface — the receipts-room slimdown took Companion, Ask and the demoted Village out', () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual(['Home', 'Family']);
    for (const retired of ['/companion', '/coach', '/saved']) {
      expect(PRIMARY_NAV.map((n) => n.href)).not.toContain(retired);
    }
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
  it('is exactly Approvals · Trail · Settings, in that order', () => {
    expect(RECEIPTS_NAV.map((n) => n.label)).toEqual(['Approvals', 'Trail', 'Settings']);
    expect(RECEIPTS_NAV.map((n) => n.href)).toEqual(['/approvals', '/trail', '/settings']);
  });

  it('every stop earns its place as a receipt or a control — no retired or demoted route is one', () => {
    const hrefs = RECEIPTS_NAV.map((n) => n.href);
    // Retired: these permanently redirect, so a stop would point at a redirect.
    for (const retired of ['/coach', '/companion', '/saved']) {
      expect(hrefs).not.toContain(retired);
    }
    // Demoted: still render, reachable by URL, but no longer destinations.
    for (const demoted of ['/home', '/plan', '/village']) {
      expect(hrefs).not.toContain(demoted);
    }
  });

  it('DEMOTED_NAV names the reachable-but-unlisted routes, and never a retired one', () => {
    expect(DEMOTED_NAV.map((n) => n.href)).toEqual(['/plan', '/village']);
    const stops = new Set<string>(RECEIPTS_NAV.map((n) => n.href));
    // A route cannot be both a stop and demoted, or the sidebar and the eyebrow
    // would disagree about whether it is a destination.
    for (const item of DEMOTED_NAV) {
      expect(stops.has(item.href)).toBe(false);
    }
  });

  it('gives every stop a distinct glyph (an aliased icon would render two stops identically)', () => {
    const icons = RECEIPTS_NAV.map((n) => n.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('primaryNav returns today IA when off and the receipts stops when on', () => {
    expect(primaryNav(false)).toEqual(PRIMARY_NAV);
    expect(primaryNav(true)).toEqual(RECEIPTS_NAV);
  });

  it('allNav keeps the eyebrow honest: the stops first, then the demoted-but-reachable routes', () => {
    const on = allNav(true);
    // The stops lead, so a shared route (/settings) resolves to its receipts label
    // rather than the old one.
    expect(on.slice(0, RECEIPTS_NAV.length)).toEqual([...RECEIPTS_NAV]);
    // A route that is no longer a stop but STILL RENDERS keeps a label, so its page
    // does not lose the running-head eyebrow.
    expect(on.map((n) => n.href)).toContain('/plan');
    expect(on.map((n) => n.href)).toContain('/village');
    const hrefs = on.map((n) => n.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('gives the demoted routes an eyebrow with the flag OFF too — they render in both IAs', () => {
    const off = allNav(false).map((n) => n.href);
    expect(off.slice(0, ALL_NAV.length)).toEqual(ALL_NAV.map((n) => n.href));
    expect(off).toContain('/plan');
    expect(off).toContain('/village');
    expect(new Set(off).size).toBe(off.length);
  });

  it('never labels a RETIRED route: a permanent redirect never renders, so an eyebrow for it is a lie', () => {
    for (const receiptsIa of [true, false]) {
      const hrefs = allNav(receiptsIa).map((n) => n.href);
      for (const retired of ['/coach', '/companion', '/saved']) {
        expect(hrefs).not.toContain(retired);
      }
    }
  });
});
