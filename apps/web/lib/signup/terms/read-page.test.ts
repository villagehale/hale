import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RegistrationPageFetch } from '~/lib/registration/page';
import { type PreflightReader, type SignupPreflightRead, readProgramTerms } from './read-page';

const markham = readFileSync(
  join(__dirname, '../../channel/spots/fixtures/markham-course.html'),
  'utf8',
);
const courseId = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const courseUrl = `https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=${courseId}`;
const child = { id: 'c-1', dateOfBirth: '2021-01-01', dobPrecision: 'exact' };
const input = {
  registrationUrl: courseUrl,
  child,
  now: new Date('2026-02-01T12:00:00Z'),
  timeZone: 'America/Toronto',
  residency: 'resident' as const,
};
const fetched = (body: string) => async (): Promise<RegistrationPageFetch> => ({
  outcome: 'fetched',
  body: Buffer.from(body),
});

const blank: SignupPreflightRead = {
  refund_quote: null,
  prerequisite_quote: null,
  prerequisite: 'none_stated',
  age_band_quote: null,
  prices: [],
  tax_quote: null,
  tax: 'unknown',
  currency_quote: null,
  currency: null,
};
const scripted = (value: SignupPreflightRead | null): PreflightReader => ({
  read: vi.fn(async () => value),
});

describe('readProgramTerms', () => {
  it('reads a BookMe4 page from its model, whatever the reader returned', async () => {
    const reader = scripted({
      ...blank,
      prices: [{ quote: 'made up', rate: 'flat', cents: 500 }],
      tax: 'plus_tax',
    });
    const got = await readProgramTerms(input, { fetchBody: fetched(markham), reader });
    expect(got.read).toBe('course_model');
    expect(got.rates).toEqual([
      { rate: 'resident', cents: 8488 },
      { rate: 'non_resident', cents: 9760 },
    ]);
    expect(got.tax).toBe('included');
    expect(got.age.fit).toBe('in_band');
  });

  it('drops a refund quote that is not on the page', async () => {
    const reader = scripted({ ...blank, refund_quote: 'Full refund any time, no questions' });
    const got = await readProgramTerms(input, { fetchBody: fetched(markham), reader });
    expect(got.refund).toBeNull();
  });

  it('keeps a refund quote that is on the page', async () => {
    const page = `<html><body>Withdrawals before the first class are refunded less a $10 fee.${markham}</body></html>`;
    const reader = scripted({
      ...blank,
      refund_quote: 'Withdrawals before the first class are refunded less a $10 fee.',
    });
    const got = await readProgramTerms(input, { fetchBody: fetched(page), reader });
    expect(got.refund).toEqual({
      quote: 'Withdrawals before the first class are refunded less a $10 fee.',
    });
  });

  it('a page that could not be fetched is unread and calls no model', async () => {
    const reader = scripted(blank);
    const got = await readProgramTerms(input, {
      fetchBody: async () => ({ outcome: 'failed', reason: 'timeout' }),
      reader,
    });
    expect(got.read).toBe('unread');
    expect(got.rates).toEqual([]);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('a failed model read leaves the page model standing', async () => {
    const got = await readProgramTerms(input, {
      fetchBody: fetched(markham),
      reader: scripted(null),
    });
    expect(got.read).toBe('course_model');
    expect(got.refund).toBeNull();
  });

  describe('on a page with no course model', () => {
    const page =
      '<html><body><h1>Pottery for kids</h1><p>Ages 5 to 8. Fee: $120.00 plus tax. Must have completed Pottery 1. Refund up to 7 days before.</p></body></html>';
    const url = 'https://rec.example-town.ca/pottery';
    const read: SignupPreflightRead = {
      refund_quote: 'Refund up to 7 days before.',
      prerequisite_quote: 'Must have completed Pottery 1.',
      prerequisite: 'required',
      age_band_quote: 'Ages 5 to 8.',
      prices: [{ quote: 'Fee: $120.00 plus tax.', rate: 'flat', cents: 12000 }],
      tax_quote: 'plus tax',
      tax: 'plus_tax',
      currency_quote: null,
      currency: null,
    };

    it('takes every quoted fact that is on the page', async () => {
      const got = await readProgramTerms(
        { ...input, registrationUrl: url },
        { fetchBody: fetched(page), reader: scripted(read) },
      );
      expect(got.read).toBe('page_text');
      expect(got.rates).toEqual([{ rate: 'flat', cents: 12000 }]);
      expect(got.tax).toBe('plus_tax');
      expect(got.prerequisite).toEqual({
        required: 'yes',
        quote: 'Must have completed Pottery 1.',
      });
      expect(got.age).toMatchObject({ fit: 'unknown', band: 'Ages 5 to 8.' });
    });

    it('binds no rate when a price quote is not on the page', async () => {
      const got = await readProgramTerms(
        { ...input, registrationUrl: url },
        {
          fetchBody: fetched(page),
          reader: scripted({
            ...read,
            prices: [{ quote: 'Fee: $99.00', rate: 'flat', cents: 9900 }],
          }),
        },
      );
      expect(got.rates).toEqual([]);
    });

    it('binds no rate when the figure is not in its quote', async () => {
      const got = await readProgramTerms(
        { ...input, registrationUrl: url },
        {
          fetchBody: fetched(page),
          reader: scripted({
            ...read,
            prices: [{ quote: 'Fee: $120.00 plus tax.', rate: 'flat', cents: 9900 }],
          }),
        },
      );
      expect(got.rates).toEqual([]);
    });

    const readRates = async (body: string, prices: SignupPreflightRead['prices']) =>
      (
        await readProgramTerms(
          { ...input, registrationUrl: url },
          {
            fetchBody: fetched(`<html><body><p>${body}</p></body></html>`),
            reader: scripted({ ...blank, prices }),
          },
        )
      ).rates;

    it('a $0 read of a quote that states a price binds no rate', async () => {
      expect(
        await readRates('Registration fee: $120.00', [
          { quote: 'Registration fee: $120.00', rate: 'flat', cents: 0 },
        ]),
      ).toEqual([]);
    });

    it('$0 due today beside a balance owed is not a free class', async () => {
      expect(
        await readRates('$0.00 due today. Balance of $120.00 due at the first class.', [
          { quote: '$0.00 due today.', rate: 'flat', cents: 0 },
        ]),
      ).toEqual([]);
    });

    it('a class the page calls free binds $0', async () => {
      expect(
        await readRates('Storytime is free for all families.', [
          { quote: 'Storytime is free', rate: 'flat', cents: 0 },
        ]),
      ).toEqual([{ rate: 'flat', cents: 0 }]);
    });

    it('free for residents beside a stated non-resident price keeps both', async () => {
      expect(
        await readRates('Residents: free. Non-residents: $40.00.', [
          { quote: 'Residents: free.', rate: 'resident', cents: 0 },
          { quote: 'Non-residents: $40.00.', rate: 'non_resident', cents: 4000 },
        ]),
      ).toEqual([
        { rate: 'resident', cents: 0 },
        { rate: 'non_resident', cents: 4000 },
      ]);
    });

    it('a page that names no prerequisite reads unknown, never no', async () => {
      const got = await readProgramTerms(
        { ...input, registrationUrl: url },
        {
          fetchBody: fetched(page),
          reader: scripted({ ...read, prerequisite: 'none_stated', prerequisite_quote: null }),
        },
      );
      expect(got.prerequisite).toEqual({ required: 'unknown', quote: null });
    });
  });
});
