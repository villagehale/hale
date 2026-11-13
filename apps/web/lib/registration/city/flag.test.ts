import { describe, expect, it } from 'vitest';
import { OWN_CITY_REGISTRATION_ENABLED_ENV, ownCityRegistrationEnabled } from './flag';

describe('OWN_CITY_REGISTRATION_ENABLED', () => {
  it('is on when unset: a kill switch, not a release flag', () => {
    expect(ownCityRegistrationEnabled({})).toBe(true);
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: 'true' })).toBe(true);
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: '' })).toBe(true);
  });

  it('is off only for "false", trimmed', () => {
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: 'false' })).toBe(
      false,
    );
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: ' false\n' })).toBe(
      false,
    );
  });
});
