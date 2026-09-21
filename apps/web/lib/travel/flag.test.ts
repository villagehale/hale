import { afterEach, describe, expect, it, vi } from 'vitest';
import { travelBriefAllowlist, travelBriefEnabled, travelBriefEnabledFor } from './flag';

/**
 * The dark-launch gate's own test, and it exists for one recorded failure: `vercel env
 * add` from a piped `echo` stores a TRAILING NEWLINE, so a value that prints as `true` is
 * really `'true\n'`. A truthiness check reads that as ON. This flag decides whether Hale
 * reads a family's booking emails at all, so failing open is the worst direction there is.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('travelBriefEnabled', () => {
  it('is on for exactly the literal "true"', () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true');
    expect(travelBriefEnabled()).toBe(true);
  });

  it('fails closed on the trailing newline a piped echo stores', () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true\n');
    expect(travelBriefEnabled()).toBe(false);
  });

  it('fails closed on every other truthy-looking spelling', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ']) {
      vi.stubEnv('TRAVEL_BRIEF_ENABLED', value);
      expect(travelBriefEnabled(), value).toBe(false);
    }
  });

  it('is off when unset', () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    expect(travelBriefEnabled()).toBe(false);
  });
});

describe('travelBriefAllowlist', () => {
  it('parses a comma-separated list, trimming and dropping blanks', () => {
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', ' fam-a , fam-b ,, ');
    expect([...travelBriefAllowlist()].sort()).toEqual(['fam-a', 'fam-b']);
  });

  it('is empty when unset', () => {
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', '');
    expect(travelBriefAllowlist().size).toBe(0);
  });
});

describe('travelBriefEnabledFor', () => {
  /**
   * THE WHOLE REASON THE ALLOWLIST EXISTS. The global flag arms detection for every
   * family F14 admits, so a live probe that flipped it would read other households'
   * mailboxes to prove one household's feature works.
   */
  it('arms one household without arming any other', () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', '');
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', 'fam-probe');
    expect(travelBriefEnabledFor('fam-probe')).toBe(true);
    // The positive control's other half: a family NOT on the list is still dark, which is
    // what makes the line above a claim about scoping rather than about the flag.
    expect(travelBriefEnabledFor('fam-other')).toBe(false);
  });

  it('the global flag admits everyone', () => {
    vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true');
    vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', '');
    expect(travelBriefEnabledFor('fam-anyone')).toBe(true);
  });
});
