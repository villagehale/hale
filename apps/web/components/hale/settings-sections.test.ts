import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION,
  resolveSection,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './settings-sections';

/**
 * The one-column Settings lane restored the anchor model, so the ids are in-page
 * anchors and the resolver is the deep-link contract: every PRIOR generation of
 * link — the pre-hub seven anchors and the hub's six section ids — must still land
 * on a live section. Expected values come from the Instinct-refresh spec's section
 * mapping, not the resolver's current output.
 */

describe('settings taxonomy', () => {
  it('is exactly the six one-column sections, in scroll order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'account',
      'notif',
      'plan',
      'apps',
      'trust',
      'about',
    ]);
  });

  it('labels each section for the flat-card headers', () => {
    const byId = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label]));
    expect(byId).toEqual({
      account: 'Account',
      notif: 'Notifications',
      plan: 'Plan',
      apps: 'Connected apps',
      trust: 'Trust',
      about: 'About',
    });
  });
});

describe('resolveSection — every old deep link keeps working', () => {
  const cases: [string, SettingsSectionId][] = [
    // pre-hub anchors
    ['#profile', 'account'],
    ['#preferences', 'account'],
    ['#appearance', 'account'],
    ['#connected-apps', 'apps'],
    ['#notifications', 'notif'],
    ['#billing', 'plan'],
    // privacy/data controls live in Trust now
    ['#privacy', 'trust'],
    // the hub's family section moved to /family; a hash resolver cannot leave the
    // page, so it falls to Account — whose card carries the pointer row.
    ['#family', 'account'],
  ];
  for (const [hash, section] of cases) {
    it(`maps ${hash} → ${section}`, () => {
      expect(resolveSection(hash)).toBe(section);
    });
  }

  it('accepts the hash without a leading # and case-insensitively', () => {
    expect(resolveSection('billing')).toBe('plan');
    expect(resolveSection('#Connected-Apps')).toBe('apps');
  });

  it('resolves each current section id to itself', () => {
    for (const { id } of SETTINGS_SECTIONS) {
      expect(resolveSection(`#${id}`)).toBe(id);
    }
  });

  it('falls back to Account for empty or unknown hashes', () => {
    expect(resolveSection('')).toBe(DEFAULT_SECTION);
    expect(resolveSection(null)).toBe(DEFAULT_SECTION);
    expect(resolveSection('#nope')).toBe(DEFAULT_SECTION);
    expect(DEFAULT_SECTION).toBe('account');
  });
});
