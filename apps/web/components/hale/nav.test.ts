import { describe, expect, it } from 'vitest';
import { DEMOTED_NAV, HISTORY_NAV, RECEIPTS_NAV, SETTINGS_NAV, primaryNav } from './nav';

describe('shared nav definition', () => {
  it('files history and settings as named routes the portal still reaches', () => {
    expect(HISTORY_NAV.href).toBe('/trail');
    expect(HISTORY_NAV.label).toBe('history');
    expect(SETTINGS_NAV.href).toBe('/settings');
    expect(SETTINGS_NAV.label).toBe('account');
  });

  it('is exactly Home · Messages · Family · Settings', () => {
    expect(primaryNav()).toEqual(RECEIPTS_NAV);
    expect(RECEIPTS_NAV.map((n) => n.label)).toEqual(['Home', 'Messages', 'Family', 'Settings']);
    expect(RECEIPTS_NAV.map((n) => n.href)).toEqual(['/home', '/messages', '/family', '/settings']);
  });

  it('every stop earns its place — no retired or demoted route is one', () => {
    const hrefs = RECEIPTS_NAV.map((n) => n.href);
    for (const retired of ['/coach', '/companion', '/saved', '/village', '/admin']) {
      expect(hrefs).not.toContain(retired);
    }
    for (const demoted of ['/approvals', '/trail', '/plan']) {
      expect(hrefs).not.toContain(demoted);
    }
  });

  it('DEMOTED_NAV names the reachable-but-unlisted routes, and never a retired one', () => {
    expect(DEMOTED_NAV.map((n) => n.href)).toEqual(['/approvals', '/trail', '/plan']);
    const stops = new Set<string>(RECEIPTS_NAV.map((n) => n.href));
    for (const item of DEMOTED_NAV) {
      expect(stops.has(item.href)).toBe(false);
    }
    expect(DEMOTED_NAV.map((n) => n.href)).not.toContain('/admin');
    expect(DEMOTED_NAV.map((n) => n.href)).not.toContain('/village');
  });

  it('gives every stop a distinct glyph', () => {
    const icons = RECEIPTS_NAV.map((n) => n.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
