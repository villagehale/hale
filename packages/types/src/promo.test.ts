import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUNDING_PROMO_ENDS_AT,
  currencyFromIpCountry,
  isFoundingPromoWindowOpen,
  parseFoundingPromoEndsAt,
} from './promo.js';

describe('currencyFromIpCountry', () => {
  it('maps US to USD', () => {
    expect(currencyFromIpCountry('US')).toBe('USD');
    expect(currencyFromIpCountry(' us ')).toBe('USD');
  });

  it('maps every other country, including Canada, to CAD', () => {
    expect(currencyFromIpCountry('CA')).toBe('CAD');
    expect(currencyFromIpCountry('GB')).toBe('CAD');
    expect(currencyFromIpCountry('FR')).toBe('CAD');
  });

  it('falls back to CAD when the header is missing or empty', () => {
    expect(currencyFromIpCountry(null)).toBe('CAD');
    expect(currencyFromIpCountry(undefined)).toBe('CAD');
    expect(currencyFromIpCountry('')).toBe('CAD');
    expect(currencyFromIpCountry('   ')).toBe('CAD');
  });
});

describe('founding promo window', () => {
  it('defaults to 2026-12-31 23:59 America/Toronto', () => {
    expect(DEFAULT_FOUNDING_PROMO_ENDS_AT).toBe('2026-12-31T23:59:00-05:00');
    expect(parseFoundingPromoEndsAt(undefined).toISOString()).toBe(
      new Date(DEFAULT_FOUNDING_PROMO_ENDS_AT).toISOString(),
    );
  });

  it('treats an unparseable override as the Toronto default', () => {
    expect(parseFoundingPromoEndsAt('not-a-date').toISOString()).toBe(
      new Date(DEFAULT_FOUNDING_PROMO_ENDS_AT).toISOString(),
    );
  });

  it('is open at the cutoff minute and closed one second later', () => {
    const ends = parseFoundingPromoEndsAt(undefined);
    expect(isFoundingPromoWindowOpen(ends, ends)).toBe(true);
    expect(isFoundingPromoWindowOpen(new Date(ends.getTime() + 1000), ends)).toBe(false);
  });

  it('is open before the cutoff', () => {
    const ends = parseFoundingPromoEndsAt(undefined);
    expect(isFoundingPromoWindowOpen(new Date('2026-11-16T00:00:00-05:00'), ends)).toBe(true);
  });
});
