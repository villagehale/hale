import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOUNDING_PROMO_ENDS_AT,
  FOUNDING_PRICE_DISPLAY,
  MAX_LIST_PRICE_DISPLAY,
  PLUS_LIST_PRICE_DISPLAY,
  PROMO_PRICE_DISPLAY,
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

describe('promo annual display', () => {
  it('pins Plus and Max yearly amounts with a plain $ and no CAD/USD label', () => {
    expect(PROMO_PRICE_DISPLAY.plus.CAD).toEqual({ symbol: '$', amount: 59, perYear: '$59/yr' });
    expect(PROMO_PRICE_DISPLAY.plus.USD).toEqual({ symbol: '$', amount: 39, perYear: '$39/yr' });
    expect(PROMO_PRICE_DISPLAY.family.CAD).toEqual({ symbol: '$', amount: 99, perYear: '$99/yr' });
    expect(PROMO_PRICE_DISPLAY.family.USD).toEqual({ symbol: '$', amount: 79, perYear: '$79/yr' });
    expect(FOUNDING_PRICE_DISPLAY.CAD.amount).toBe(79);
    expect(FOUNDING_PRICE_DISPLAY.USD.amount).toBe(59);
  });
});

describe('Plus list display', () => {
  it('pins the public Plus amounts with a plain $ and no currency label', () => {
    expect(PLUS_LIST_PRICE_DISPLAY.CAD).toEqual({
      monthlyLabel: '$19/mo',
      annualLabel: '$159/yr',
      monthlyCents: 1900,
      annualCents: 15900,
    });
    expect(PLUS_LIST_PRICE_DISPLAY.USD).toEqual({
      monthlyLabel: '$14/mo',
      annualLabel: '$119/yr',
      monthlyCents: 1400,
      annualCents: 11900,
    });
  });
});

describe('Max list annual display', () => {
  it('pins CAD 32900 and USD 25900 for after the cutoff, with a plain $', () => {
    expect(MAX_LIST_PRICE_DISPLAY.CAD).toEqual({
      annualLabel: '$329/yr',
      annualCents: 32900,
    });
    expect(MAX_LIST_PRICE_DISPLAY.USD).toEqual({
      annualLabel: '$259/yr',
      annualCents: 25900,
    });
  });
});
