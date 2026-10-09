import { describe, expect, it } from 'vitest';
import { glueMonthDay } from './month-day';

describe('glueMonthDay', () => {
  it('ties the month to the day so the date cannot wrap', () => {
    expect(glueMonthDay('You told Hale · Sep 14')).toBe('You told Hale · Sep\u00A014');
    expect(glueMonthDay('You told Hale · Aug 17')).toBe('You told Hale · Aug\u00A017');
    expect(glueMonthDay('Dec 3 and Jan 12')).toBe('Dec\u00A03 and Jan\u00A012');
  });

  it('leaves a date that is already tied', () => {
    const tied = 'Sep\u00A014';
    expect(glueMonthDay(tied)).toBe(tied);
  });
});
