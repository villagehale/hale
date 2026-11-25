import { describe, expect, it } from 'vitest';
import { acceptDobReading, signupDobReadUserMessage } from './dob-reader';

const now = new Date('2026-11-21T12:00:00Z');

describe('acceptDobReading', () => {
  it('accepts a date backed by the parent words', () => {
    const text = 'She was born March 21, 2022';
    expect(
      acceptDobReading(
        { said: 'March 21, 2022', date: '2022-03-21', otherPerson: false },
        text,
        now,
      ),
    ).toBe('2022-03-21');
  });

  it('accepts a two-digit year in their words', () => {
    const text = 'dob 21/03/22';
    expect(
      acceptDobReading({ said: '21/03/22', date: '2022-03-21', otherPerson: false }, text, now),
    ).toBe('2022-03-21');
  });

  const read = (said: string, date: string) =>
    acceptDobReading({ said, date, otherPerson: false }, `born ${said}`, now);

  it.each([
    ['March 21, 2022', '2022-03-21'],
    ['21 mars 2022', '2022-03-21'],
    ['2022年3月21日', '2022-03-21'],
    ['2022-03-04', '2022-03-04'],
    ['04/04/2021', '2021-04-04'],
    ['Mar 5 2021', '2021-03-05'],
  ])('accepts %s, each part from its own word', (said, date) => {
    expect(read(said, date)).toBe(date);
  });

  it.each([
    ['the month is not in their words', 'March 21, 2022', '2022-04-21'],
    ['one number stands for the day and the year', 'the 21st of May', '2021-05-21'],
    ['one number stands for the month and the day', 'May 5', '2021-05-05'],
    ['day and month could be swapped', '03/04/2021', '2021-03-04'],
  ])('refuses when %s', (_case, said, date) => {
    expect(read(said, date)).toBeNull();
  });

  it('refuses a quote that is not theirs', () => {
    const text = 'she is about four';
    expect(
      acceptDobReading(
        { said: 'March 21, 2022', date: '2022-03-21', otherPerson: false },
        text,
        now,
      ),
    ).toBeNull();
  });

  it('refuses a date whose day their words do not carry', () => {
    const text = 'born in March 2022';
    expect(
      acceptDobReading({ said: 'March 2022', date: '2022-03-21', otherPerson: false }, text, now),
    ).toBeNull();
  });

  it('refuses a date whose year their words do not carry', () => {
    const text = 'her birthday is March 21';
    expect(
      acceptDobReading({ said: 'March 21', date: '2022-03-21', otherPerson: false }, text, now),
    ).toBeNull();
  });

  it('refuses a date that is not real', () => {
    const text = 'February 30, 2022';
    expect(
      acceptDobReading({ said: text, date: '2022-02-30', otherPerson: false }, text, now),
    ).toBeNull();
  });

  it('refuses a date in the future', () => {
    const text = 'December 1, 2027';
    expect(
      acceptDobReading({ said: text, date: '2027-12-01', otherPerson: false }, text, now),
    ).toBeNull();
  });

  it("a date the reader marks as someone else's is never this child's", () => {
    const text = 'her brother was born March 21, 2019';
    expect(
      acceptDobReading(
        { said: 'March 21, 2019', date: '2019-03-21', otherPerson: true },
        text,
        now,
      ),
    ).toBeNull();
    // Positive control: the same words, read as this child's, hold.
    expect(
      acceptDobReading(
        { said: 'March 21, 2019', date: '2019-03-21', otherPerson: false },
        text,
        now,
      ),
    ).toBe('2019-03-21');
  });

  it('the reader is told which child Hale asked about', () => {
    expect(JSON.parse(signupDobReadUserMessage({ text: 'hi', childFirstName: 'Ada' }))).toEqual({
      child_first_name: 'Ada',
      text: 'hi',
    });
  });

  it('refuses a null reading', () => {
    expect(acceptDobReading({ said: null, date: null, otherPerson: false }, 'hi', now)).toBeNull();
  });
});
