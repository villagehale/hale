import { describe, expect, it } from 'vitest';
import { OWN_CITY_REGISTRATION_ENABLED_ENV, ownCityRegistrationEnabled } from './flag';

describe('OWN_CITY_REGISTRATION_ENABLED', () => {
  it('is off when unset: a release flag, not a kill switch', () => {
    expect(ownCityRegistrationEnabled({})).toBe(false);
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: '' })).toBe(false);
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: 'false' })).toBe(
      false,
    );
  });

  it('is on for trimmed true', () => {
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: 'true' })).toBe(true);
    expect(ownCityRegistrationEnabled({ [OWN_CITY_REGISTRATION_ENABLED_ENV]: ' true\n' })).toBe(
      true,
    );
  });
});
