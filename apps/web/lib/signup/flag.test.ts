import { describe, expect, it } from 'vitest';
import { authorizedSignupEnabled } from './flag';

describe('authorizedSignupEnabled', () => {
  it('is on only for the exact string on', () => {
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'on' })).toBe(true);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'on\n' })).toBe(true);
  });

  it('stays off for every other value, including unset', () => {
    expect(authorizedSignupEnabled({})).toBe(false);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: '' })).toBe(false);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'true' })).toBe(false);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'ON' })).toBe(false);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: '1' })).toBe(false);
    expect(authorizedSignupEnabled({ AUTHORIZED_SIGNUP_ENABLED: 'off' })).toBe(false);
  });
});
