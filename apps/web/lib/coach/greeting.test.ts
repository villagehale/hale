import { describe, expect, it } from 'vitest';
import { greetingLine, timeOfDayGreeting } from './greeting';

/**
 * The Ask empty-state greeting. The boundary hours are derived from the spec
 * (morning < 12, afternoon < 18, evening otherwise), not copied from output, and
 * checked at each edge so a shifted boundary fails.
 */
describe('timeOfDayGreeting', () => {
  it('greets the morning before noon', () => {
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 0, 0))).toBe('Good morning');
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 11, 59))).toBe('Good morning');
  });

  it('greets the afternoon from noon to 6pm', () => {
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 12, 0))).toBe('Good afternoon');
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 17, 59))).toBe('Good afternoon');
  });

  it('greets the evening from 6pm', () => {
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 18, 0))).toBe('Good evening');
    expect(timeOfDayGreeting(new Date(2026, 6, 19, 23, 59))).toBe('Good evening');
  });
});

describe('greetingLine', () => {
  it('interpolates the parent first name', () => {
    expect(greetingLine('Alex', new Date(2026, 6, 19, 19, 0))).toBe('Good evening, Alex.');
  });

  it('drops the name when none is known', () => {
    expect(greetingLine(null, new Date(2026, 6, 19, 9, 0))).toBe('Good morning.');
  });
});
