import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUNDING_PROMO_ENDS_AT,
  PLUS_LIST_PRICE_DISPLAY,
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
  it('defaults to 2027-01-01 00:00 America/Toronto (exclusive)', () => {
    expect(DEFAULT_FOUNDING_PROMO_ENDS_AT).toBe('2027-01-01T00:00:00-05:00');
    expect(parseFoundingPromoEndsAt(undefined).toISOString()).toBe(
      new Date(DEFAULT_FOUNDING_PROMO_ENDS_AT).toISOString(),
    );
  });

  it('treats an unparseable override as the Toronto default', () => {
    expect(parseFoundingPromoEndsAt('not-a-date').toISOString()).toBe(
      new Date(DEFAULT_FOUNDING_PROMO_ENDS_AT).toISOString(),
    );
  });

  it('is open in the last second of 31 Dec and closed at the cutoff instant', () => {
    const ends = parseFoundingPromoEndsAt(undefined);
    expect(isFoundingPromoWindowOpen(new Date(ends.getTime() - 1000), ends)).toBe(true);
    expect(isFoundingPromoWindowOpen(ends, ends)).toBe(false);
  });

  it('is open before the cutoff', () => {
    const ends = parseFoundingPromoEndsAt(undefined);
    expect(isFoundingPromoWindowOpen(new Date('2026-11-16T00:00:00-05:00'), ends)).toBe(true);
  });
});

describe('Plus list display', () => {
  it('pins CAD to the existing public Plus copy and USD to create-prices cents', () => {
    expect(PLUS_LIST_PRICE_DISPLAY.CAD).toEqual({
      monthlyLabel: 'C$19/mo',
      annualLabel: 'C$159/yr',
      monthlyCents: 1900,
      annualCents: 15900,
    });
    expect(PLUS_LIST_PRICE_DISPLAY.USD).toEqual({
      monthlyLabel: 'US$14/mo',
      annualLabel: 'US$119/yr',
      monthlyCents: 1400,
      annualCents: 11900,
    });
  });
});
