import { afterEach, describe, expect, it, vi } from 'vitest';
import { visitorCurrencyFromHeaders } from './visitor-currency.js';

function headers(country: string | null): { get(name: string): string | null } {
  return {
    get(name) {
      return name.toLowerCase() === 'x-vercel-ip-country' ? country : null;
    },
  };
}

describe('visitorCurrencyFromHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('maps US to USD and everything else, including a missing header, to CAD', () => {
    expect(visitorCurrencyFromHeaders(headers('US'))).toBe('USD');
    expect(visitorCurrencyFromHeaders(headers('CA'))).toBe('CAD');
    expect(visitorCurrencyFromHeaders(headers('GB'))).toBe('CAD');
    expect(visitorCurrencyFromHeaders(headers(null))).toBe('CAD');
  });

  it('returns null for a missing or non-US/CA country when the server-currency flag is on', () => {
    vi.stubEnv('CHECKOUT_SERVER_CURRENCY_ENABLED', 'true');
    expect(visitorCurrencyFromHeaders(headers('US'))).toBe('USD');
    expect(visitorCurrencyFromHeaders(headers('CA'))).toBe('CAD');
    expect(visitorCurrencyFromHeaders(headers('MX'))).toBeNull();
    expect(visitorCurrencyFromHeaders(headers(null))).toBeNull();
    vi.stubEnv('CHECKOUT_SERVER_CURRENCY_ENABLED', 'TRUE');
    expect(visitorCurrencyFromHeaders(headers('MX'))).toBe('CAD');
  });
});
