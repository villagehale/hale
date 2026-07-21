import { describe, expect, it } from 'vitest';

import { dateToTimeValue, timeStringToDate, timeStringToLabel } from './loop-time';

/**
 * The F11 loop-time clock helpers. Expected values are derived from the format
 * spec (12-hour label with meridiem; zero-padded 24h wire value), not copied from
 * the code's output.
 */

describe('timeStringToLabel', () => {
  it('formats a 24h wire time as a 12-hour label', () => {
    expect(timeStringToLabel('21:30:00')).toBe('9:30 PM');
    expect(timeStringToLabel('07:30:00')).toBe('7:30 AM');
  });

  it('renders both midnight and noon as 12 (not 0)', () => {
    expect(timeStringToLabel('00:00:00')).toBe('12:00 AM');
    expect(timeStringToLabel('12:00:00')).toBe('12:00 PM');
  });

  it('accepts an HH:MM value with no seconds', () => {
    expect(timeStringToLabel('19:30')).toBe('7:30 PM');
  });
});

describe('dateToTimeValue', () => {
  it('emits a zero-padded 24h HH:MM', () => {
    expect(dateToTimeValue(new Date(2026, 6, 20, 9, 5))).toBe('09:05');
    expect(dateToTimeValue(new Date(2026, 6, 20, 21, 30))).toBe('21:30');
  });
});

describe('timeStringToDate → dateToTimeValue round-trip', () => {
  it('preserves the hour and minute', () => {
    expect(dateToTimeValue(timeStringToDate('07:05:00'))).toBe('07:05');
    expect(dateToTimeValue(timeStringToDate('23:59'))).toBe('23:59');
  });
});
