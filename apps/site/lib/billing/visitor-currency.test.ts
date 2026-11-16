import { describe, expect, it } from 'vitest';
import { visitorCurrencyFromHeaders } from './visitor-currency.js';

function headers(country: string | null): { get(name: string): string | null } {
  return {
    get(name) {
      return name.toLowerCase() === 'x-vercel-ip-country' ? country : null;
    },
  };
}

describe('visitorCurrencyFromHeaders', () => {
  it('maps US to USD and everything else, including a missing header, to CAD', () => {
    expect(visitorCurrencyFromHeaders(headers('US'))).toBe('USD');
    expect(visitorCurrencyFromHeaders(headers('CA'))).toBe('CAD');
    expect(visitorCurrencyFromHeaders(headers('GB'))).toBe('CAD');
    expect(visitorCurrencyFromHeaders(headers(null))).toBe('CAD');
  });
});
