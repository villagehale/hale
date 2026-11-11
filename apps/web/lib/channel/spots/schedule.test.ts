import { describe, expect, it } from 'vitest';
import { SCHEDULE_MAX, checkedSchedule } from './schedule';

/**
 * The one check both spot readers put a page's schedule through before it can reach a
 * spot-open text. A third party writes that value, and its digits back the numbers the
 * writer may print, so anything that is not a day and a clock time becomes null.
 */
describe('checkedSchedule', () => {
  it.each([
    ['Tuesdays 4:30 PM'],
    ['Saturday 09:30 AM'],
    ['Monday 05:00 PM'],
    ['Sat 10am'],
    ['Mon, Wed 6:30 PM'],
    ['Tuesdays and Thursdays 4:30-5:15 PM'],
    ['Saturday, Jan 10 9:00 AM'],
    ['Jan 10 to Mar 14, 9-10am'],
    ['samedi 10h15'],
    ['mardi 17 h 30'],
  ])('keeps a real schedule: %s', (schedule) => {
    expect(checkedSchedule(schedule)).toBe(schedule);
  });

  it('collapses spacing the page put around a real schedule', () => {
    expect(checkedSchedule('  Monday   05:00 PM ')).toBe('Monday 05:00 PM');
  });

  it.each([
    ['a phone number', 'Call 555 0100 to claim'],
    ['a phone number beside a real schedule', 'Monday 05:00 PM call 555 0123'],
    ['a stray number beside a real schedule', 'Monday 05:00 PM room 12'],
    ['a day of the month with no month', 'Monday 12 05:00 PM'],
    ['a day with no time', 'Tuesdays'],
    ['a time with no day or date', '4:30 PM'],
    ['words a schedule does not use', 'Monday 05:00 PM text JOIN now'],
    ['a link', 'Sat 10am evil.io/x'],
    ['an hour that is no hour', 'Monday 27:00'],
    ['nothing', '   '],
  ])('drops %s', (_name, value) => {
    expect(checkedSchedule(value)).toBeNull();
  });

  it(`drops a value over ${SCHEDULE_MAX} characters, even a real schedule`, () => {
    const long = 'Mondays, Tuesdays, Wednesdays, Thursdays and Fridays 4:30-5:15 PM';
    expect(long.length).toBeGreaterThan(SCHEDULE_MAX);
    expect(checkedSchedule(long)).toBeNull();
    expect(checkedSchedule('Mondays and Fridays 4:30-5:15 PM')).toBe(
      'Mondays and Fridays 4:30-5:15 PM',
    );
  });
});
