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
