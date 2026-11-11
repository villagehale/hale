import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEEN_NAME_SHARED_MATCHER_ENABLED_ENV,
  teenNameIn,
  teenNameSharedMatcherEnabled,
} from './teen-name';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TEEN_NAME_SHARED_MATCHER_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, 'true');
    expect(teenNameSharedMatcherEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, value);
      expect(teenNameSharedMatcherEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, undefined);
    expect(teenNameSharedMatcherEnabled()).toBe(false);
    expect(teenNameSharedMatcherEnabled({})).toBe(false);
  });
});

describe('teenNameIn', () => {
  it('unlit, misses an accented stored name the shared matcher would catch', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, undefined);
    expect(teenNameIn('Támsin has debate', ['Tamsin'])).toBe(false);
  });

  it('lit, names a stored name with accents, format characters and name parts', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, 'true');
    expect(teenNameIn('Támsin has debate', ['Tamsin'])).toBe(true);
    expect(teenNameIn('Ta\u200Bmsin has debate', ['Tamsin'])).toBe(true);
    expect(teenNameIn('Sofia has debate', ['Ana Sofia'])).toBe(true);
    expect(teenNameIn('Tamsinfield road', ['Tamsin'])).toBe(false);
  });
});
