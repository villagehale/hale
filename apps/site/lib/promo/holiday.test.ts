import { describe, expect, it } from 'vitest';
import { promoOverrides, promoPhase, resolveHolidayPromo } from './holiday';

const ON = { HOLIDAY_PROMO_ENABLED: 'true' };

describe('holiday promo phase', () => {
  it('is the Black Friday Sale through Nov 30 and the Holiday Sale from Dec 1 00:00 Toronto', () => {
    expect(promoPhase(new Date('2026-11-16T00:00:00-05:00'))).toBe('black_friday');
    expect(promoPhase(new Date('2026-11-30T23:59:59-05:00'))).toBe('black_friday');
    expect(promoPhase(new Date('2026-12-01T00:00:00-05:00'))).toBe('holiday');
    expect(promoPhase(new Date('2026-12-31T23:00:00-05:00'))).toBe('holiday');
  });
});

describe('resolveHolidayPromo', () => {
  const now = new Date('2026-11-20T12:00:00-05:00');

  it('stays dark in production until HOLIDAY_PROMO_ENABLED is exactly true', () => {
    expect(
      resolveHolidayPromo({ now, country: 'CA', env: { VERCEL_ENV: 'production' } }),
    ).toBeNull();
    expect(
      resolveHolidayPromo({
        now,
        country: 'CA',
        env: { VERCEL_ENV: 'production', HOLIDAY_PROMO_ENABLED: '1' },
      }),
    ).toBeNull();
    expect(
      resolveHolidayPromo({ now, country: 'CA', env: { VERCEL_ENV: 'production', ...ON } }),
    ).not.toBeNull();
  });

  it('shows on Vercel Preview for review', () => {
    expect(resolveHolidayPromo({ now, country: 'CA', env: { VERCEL_ENV: 'preview' } })?.phase).toBe(
      'black_friday',
    );
  });

  it('is closed before Nov 16 and after the Dec 31 23:59 Toronto cutoff', () => {
    expect(
      resolveHolidayPromo({ now: new Date('2026-11-15T23:59:00-05:00'), country: 'CA', env: ON }),
    ).toBeNull();
    expect(
      resolveHolidayPromo({ now: new Date('2026-12-31T23:59:00-05:00'), country: 'CA', env: ON }),
    ).not.toBeNull();
    expect(
      resolveHolidayPromo({ now: new Date('2027-01-01T00:00:01-05:00'), country: 'CA', env: ON }),
    ).toBeNull();
  });

  it('prices a US visitor in USD and everyone else in CAD', () => {
    const us = resolveHolidayPromo({ now, country: 'US', env: ON });
    expect(us).toMatchObject({
      currency: 'USD',
      symbol: '$',
      plus: { regular: 119, sale: 39, regularLabel: '$119/yr', saleLabel: '$39/yr' },
      max: { regular: 259, sale: 79, regularLabel: '$259/yr', saleLabel: '$79/yr' },
    });
    for (const country of ['CA', 'GB', null] as const) {
      const ca = resolveHolidayPromo({ now, country, env: ON });
      expect(ca).toMatchObject({
        currency: 'CAD',
        symbol: '$',
        plus: { regular: 159, sale: 59, regularLabel: '$159/yr', saleLabel: '$59/yr' },
        max: { regular: 329, sale: 99, regularLabel: '$329/yr', saleLabel: '$99/yr' },
      });
    }
  });

  it('keeps the bare $ and hides the sale for an explicit non-US/CA country', () => {
    const strict = { ...ON, CHECKOUT_SERVER_CURRENCY_ENABLED: 'true' };
    const us = resolveHolidayPromo({ now, country: 'US', env: strict });
    expect(us?.plus.saleLabel).toBe('$39/yr');
    expect(us?.max.saleLabel).toBe('$79/yr');
    expect(us?.plus.saleLabel).not.toMatch(/USD|CAD/);
    expect(resolveHolidayPromo({ now, country: 'CA', env: strict })?.plus.saleLabel).toBe('$59/yr');
    expect(resolveHolidayPromo({ now, country: 'MX', env: strict })).toBeNull();
    expect(resolveHolidayPromo({ now, country: null, env: strict })?.currency).toBe('CAD');
    expect(resolveHolidayPromo({ now, country: 'GB', env: strict })).toBeNull();
  });
});

describe('promoOverrides', () => {
  it('lets Preview pick a phase and country', () => {
    expect(
      promoOverrides(
        { promo_phase: 'holiday', promo_cc: 'us', promo: 'on' },
        { VERCEL_ENV: 'preview' },
      ),
    ).toEqual({
      phase: 'holiday',
      country: 'US',
      show: true,
    });
  });

  it('is ignored in production, so an ad link cannot change the offer', () => {
    expect(
      promoOverrides(
        { promo_phase: 'holiday', promo_cc: 'US', promo: 'on' },
        { VERCEL_ENV: 'production' },
      ),
    ).toEqual({});
  });
});
