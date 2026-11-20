import { describe, expect, it } from 'vitest';
import { providerAccountCreateEnabled, providerCredentialsEnabled } from './flag';

describe('provider credential flags', () => {
  it('are on only for exactly true', () => {
    expect(providerCredentialsEnabled({})).toBe(false);
    expect(providerAccountCreateEnabled({})).toBe(false);
    for (const value of ['', 'on', '1', 'TRUE', 'true\n']) {
      expect(providerCredentialsEnabled({ PROVIDER_CREDENTIALS_ENABLED: value }), value).toBe(
        false,
      );
      expect(providerAccountCreateEnabled({ PROVIDER_ACCOUNT_CREATE_ENABLED: value }), value).toBe(
        false,
      );
    }
    expect(providerCredentialsEnabled({ PROVIDER_CREDENTIALS_ENABLED: 'true' })).toBe(true);
    expect(providerAccountCreateEnabled({ PROVIDER_ACCOUNT_CREATE_ENABLED: 'true' })).toBe(true);
  });
});
