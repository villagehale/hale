import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepPageQuote, readCourseTerms, residencyFor } from './evaluate';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../channel/spots/fixtures', name), 'utf8');

const markham = fixture('markham-course.html');
const markhamCourseId = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';
const newmarket = fixture('newmarket-course.html');
const newmarketCourseId = /"EventId":"([^"]+)"/.exec(newmarket)?.[1] as string;
const timeZone = 'America/Toronto';
// Before the course, so every instant the band is checked at is a real one.
const now = new Date('2026-02-01T12:00:00Z');

const read = (dateOfBirth: string, dobPrecision = 'exact', raw = markham) =>
  readCourseTerms({
    rawHtml: raw,
    courseId: markhamCourseId,
    timeZone,
    now,
    residency: 'unknown',
    child: { id: 'c-1', dateOfBirth, dobPrecision },
  });

describe('readCourseTerms', () => {
  it('reads the identity, rates and tax of the saved Markham page', () => {
    const got = read('2021-01-01');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.terms.read).toBe('course_model');
    expect(got.terms.program).toEqual({
      courseIds: ['283993', markhamCourseId],
      name: 'Get Ready Public Speaking',
    });
    expect(got.terms.rates).toEqual([
      { rate: 'resident', cents: 8488 },
      { rate: 'non_resident', cents: 9760 },
    ]);
    expect(got.terms.tax).toBe('included');
    expect(got.terms.age.band).toBe('4 to 6');
    expect(got.terms.prerequisite).toEqual({ required: 'no', quote: null });
  });

  describe('a printed price of nothing', () => {
    const priced = (amount: string, display: string) =>
      read(
        '2021-01-01',
        'exact',
        markham
          .replace('"Amount":84.88', `"Amount":${amount}`)
          .replace('"DisplayAmount":"$84.88"', `"DisplayAmount":"${display}"`)
          .replace('"DisplayAmountOrAsFree":"$84.88"', `"DisplayAmountOrAsFree":"${display}"`),
      );

    it.each([
      ['an amount under a cent', '0.004', '$0.00'],
      ['an amount of zero printed as a price', '0', '$5.00'],
      ['an amount of zero printed as nothing readable', '0', 'TBD'],
    ])('%s binds no rate', (_case, amount, display) => {
      const got = priced(amount, display);
      expect(got.ok && got.terms.rates).toEqual([]);
    });

    it.each([
      ['$0.00', '0', '$0.00'],
      ['Free', '0', 'Free'],
    ])('a zero the page prints as %s is free', (_case, amount, display) => {
      const got = priced(amount, display);
      expect(got.ok && got.terms.rates).toEqual([
        { rate: 'resident', cents: 0 },
        { rate: 'non_resident', cents: 9760 },
      ]);
    });
  });

  it('a 5-year-old is in band', () => {
    const got = read('2021-01-01');
    expect(got.ok && got.terms.age.fit).toBe('in_band');
  });

  it('a 3-year-old and an 8-year-old are outside the band', () => {
    const three = read('2023-01-01');
    const eight = read('2018-01-01');
    expect(three.ok && three.terms.age.fit).toBe('outside_band');
    expect(eight.ok && eight.terms.age.fit).toBe('outside_band');
  });

  it('a child turning 4 a week before the first class is unknown, not a stop', () => {
    // The first class is 2026-03-28; on 2026-02-01 this child is still 3.
    const got = read('2022-03-21');
    expect(got.ok && got.terms.age.fit).toBe('unknown');
  });

  it('a derived birth date is unknown', () => {
    const got = read('2021-01-01', 'derived');
    expect(got.ok && got.terms.age.fit).toBe('unknown');
  });

  it('a stale age-rule date on the page does not move a child who is in band', () => {
    // AgeRuleSpecificDate on the saved page sits years before the course; this child was
    // not born on it, and is 5 at every real instant.
    expect(markham).toMatch(/"AgeRuleSpecificDate":"20/);
    const got = read('2020-11-01');
    expect(got.ok && got.terms.age.fit).toBe('in_band');
  });

  it('Newmarket reads plus tax', () => {
    const got = readCourseTerms({
      rawHtml: newmarket,
      courseId: newmarketCourseId,
      timeZone,
      now,
      residency: 'unknown',
      child: { id: 'c-1', dateOfBirth: '2012-01-01', dobPrecision: 'exact' },
    });
    expect(got.ok && got.terms.tax).toBe('plus_tax');
    expect(got.ok && got.terms.rates).toEqual([
      { rate: 'resident', cents: 33627 },
      { rate: 'non_resident', cents: 43565 },
    ]);
  });

  it('a page with PrerequisiteEvents true reads as required', () => {
    const edited = markham.replace('"PrerequisiteEvents":false', '"PrerequisiteEvents":true');
    const got = read('2021-01-01', 'exact', edited);
    expect(got.ok && got.terms.prerequisite.required).toBe('yes');
  });

  it('a four-row price table binds no rate', () => {
    const page = fixture('markham-course.html').replace(
      /"Prices":\[(\{.*?\}),(\{.*?\})\]/,
      '"Prices":[$1,$2,$1,$2]',
    );
    const got = read('2021-01-01', 'exact', page);
    expect(got.ok && got.terms.rates).toEqual([]);
  });

  it('a page for another course is not read', () => {
    const got = readCourseTerms({
      rawHtml: markham,
      courseId: 'aaaaaaaa-0000-4000-8000-000000000000',
      timeZone,
      now,
      residency: 'unknown',
      child: { id: 'c-1', dateOfBirth: '2021-01-01', dobPrecision: 'exact' },
    });
    expect(got.ok).toBe(false);
  });

  it('picks the page open that applies to a known resident', () => {
    const page = readCourseTerms({
      rawHtml: markham,
      courseId: markhamCourseId,
      timeZone,
      now: new Date('2026-02-01T12:00:00Z'),
      residency: 'resident',
      child: { id: 'c-1', dateOfBirth: '2021-01-01', dobPrecision: 'exact' },
    });
    const pub = readCourseTerms({
      rawHtml: markham,
      courseId: markhamCourseId,
      timeZone,
      now: new Date('2026-02-01T12:00:00Z'),
      residency: 'non_resident',
      child: { id: 'c-1', dateOfBirth: '2021-01-01', dobPrecision: 'exact' },
    });
    expect(page.ok && page.terms.pageOpensAt?.toISOString()).toBe('2026-02-24T11:30:00.000Z');
    expect(pub.ok && pub.terms.pageOpensAt?.toISOString()).toBe('2026-02-25T11:30:00.000Z');
  });

  it('an open already past is not a future open', () => {
    const got = readCourseTerms({
      rawHtml: markham,
      courseId: markhamCourseId,
      timeZone,
      now: new Date('2026-03-01T12:00:00Z'),
      residency: 'unknown',
      child: { id: 'c-1', dateOfBirth: '2021-01-01', dobPrecision: 'exact' },
    });
    expect(got.ok && got.terms.pageOpensAt).toBeNull();
  });
});

describe('keepPageQuote', () => {
  const page = 'Refunds are available until 7 days before the first class, less a $10 fee.';

  it('keeps a quote that is on the page, case and spacing aside', () => {
    expect(keepPageQuote('refunds are  available until 7 days before the first class', page)).toBe(
      'refunds are  available until 7 days before the first class',
    );
  });

  it('drops a quote that is not on the page', () => {
    expect(keepPageQuote('Full refund any time', page)).toBeNull();
  });

  it('drops an empty quote and null', () => {
    expect(keepPageQuote('   ', page)).toBeNull();
    expect(keepPageQuote(null, page)).toBeNull();
  });
});

describe('residencyFor', () => {
  it('a Markham postal code is a resident of the Markham portal', () => {
    expect(residencyFor('cityofmarkham.perfectmind.com', 'L3R 1A1')).toBe('resident');
  });

  it('a Toronto postal code is a non-resident there', () => {
    expect(residencyFor('cityofmarkham.perfectmind.com', 'M5V 1A1')).toBe('non_resident');
  });

  it('a code that straddles the portal town is unknown', () => {
    expect(residencyFor('cityofmarkham.perfectmind.com', 'L4J 1A1')).toBe('unknown');
  });

  it('a portal outside the registry is unknown', () => {
    expect(residencyFor('newmarket.perfectmind.com', 'L3Y 1A1')).toBe('unknown');
  });

  it('no postal code is unknown', () => {
    expect(residencyFor('cityofmarkham.perfectmind.com', null)).toBe('unknown');
  });
});
