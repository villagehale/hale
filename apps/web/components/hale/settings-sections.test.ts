import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION,
  resolveSection,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './settings-sections';

/**
 * The hub is a six-section switcher that replaced the old seven-anchor Account
 * page. These pin the taxonomy (§4.7) and the deep-link contract: every OLD
 * anchor must still resolve to a live section so an existing link (an email, the
 * Family hub's /settings#billing) never dead-ends. Expected values come from the
 * spec's section mapping, not the resolver's current output.
 */

describe('settings taxonomy', () => {
  it('is exactly the six sections of the handoff, in order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'account',
      'family',
      'plan',
      'notif',
      'apps',
      'about',
    ]);
  });

  it('labels each section per §4.7', () => {
    const byId = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s.id, s.label]));
    expect(byId).toEqual({
      account: 'Account',
      family: 'Family & children',
      plan: 'Plan & billing',
      notif: 'Notifications',
      apps: 'Connected apps',
      about: 'Support & about',
    });
  });
});

describe('resolveSection — old deep links keep working', () => {
  const cases: [string, SettingsSectionId][] = [
    ['#profile', 'account'],
    ['#preferences', 'account'],
    ['#appearance', 'account'],
    ['#connected-apps', 'apps'],
    ['#notifications', 'notif'],
    ['#billing', 'plan'],
    ['#privacy', 'about'],
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

  it('resolves each new section id to itself', () => {
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
