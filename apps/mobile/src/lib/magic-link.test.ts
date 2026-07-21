import { describe, expect, it } from 'vitest';
import {
  type MagicPhase,
  initialMagicPhase,
  isPlausibleEmail,
  magicTokenFromParams,
  shouldAttemptToken,
} from './magic-link';

describe('isPlausibleEmail', () => {
  it('accepts a normal address', () => {
    expect(isPlausibleEmail('parent@example.com')).toBe(true);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isPlausibleEmail('  parent@example.com  ')).toBe(true);
  });

  it.each(['', '   ', 'parent', 'parent@', '@example.com', 'parent@example', 'a b@example.com'])(
    'rejects the implausible address %j',
    (bad) => {
      expect(isPlausibleEmail(bad)).toBe(false);
    },
  );
});

describe('magicTokenFromParams', () => {
  it('returns the token string when present', () => {
    expect(magicTokenFromParams('abc123')).toBe('abc123');
  });

  it('takes the first when expo-router hands a repeated param as an array', () => {
    expect(magicTokenFromParams(['abc123', 'dup'])).toBe('abc123');
  });

  it('trims a padded token', () => {
    expect(magicTokenFromParams('  abc123  ')).toBe('abc123');
  });

  it.each([undefined, '', '   '])('returns null for the missing/empty param %j', (v) => {
    expect(magicTokenFromParams(v)).toBeNull();
  });
});

describe('initialMagicPhase', () => {
  it('verifies when a token is present', () => {
    expect(initialMagicPhase('abc')).toBe('verifying' satisfies MagicPhase);
  });

  it('fails immediately when the token is missing (nothing to redeem)', () => {
    expect(initialMagicPhase(null)).toBe('failed' satisfies MagicPhase);
  });
});

describe('shouldAttemptToken', () => {
  it('attempts a fresh token when none has been tried yet', () => {
    expect(shouldAttemptToken('tok', null)).toBe(true);
  });

  it('does not re-fire the token already acted on', () => {
    expect(shouldAttemptToken('tok', 'tok')).toBe(false);
  });

  it('re-attempts when a new token replaces a previously tried one (failure-screen relink)', () => {
    expect(shouldAttemptToken('fresh', 'stale')).toBe(true);
  });

  it.each([
    [null, null],
    [null, 'tok'],
  ])('never attempts a missing token (%j after %j)', (token, last) => {
    expect(shouldAttemptToken(token, last)).toBe(false);
  });
});
