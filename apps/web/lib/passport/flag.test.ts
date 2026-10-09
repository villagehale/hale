import { afterEach, describe, expect, it, vi } from 'vitest';
import { INTEREST_PASSPORT_ENABLED_ENV, interestPassportEnabled } from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('INTEREST_PASSPORT_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(INTEREST_PASSPORT_ENABLED_ENV, 'true');
    expect(interestPassportEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(INTEREST_PASSPORT_ENABLED_ENV, value);
      expect(interestPassportEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(INTEREST_PASSPORT_ENABLED_ENV, undefined);
    expect(interestPassportEnabled()).toBe(false);
    expect(interestPassportEnabled({})).toBe(false);
  });
});
