import { describe, expect, it } from 'vitest';
import { pinYearByWeekday } from '../verify-window';
import { winterCycleLabel, winterRegistrationWindow } from './cycle';

describe('the coming winter, and the days it registers in', () => {
  it('turns to next winter in February, and pins only a date that registers for it', () => {
    const february = new Date('2027-02-15T15:00:00Z');
    expect(winterCycleLabel(february)).toBe('Winter 2028');
    const season = winterRegistrationWindow(february);
    expect(season).toEqual({ from: '2027-10-01', through: '2028-01-31' });
    // Spring, summer and fall 2027 dates are ahead and fit one year by weekday, but are
    // not Winter 2028's registration.
    for (const quote of [
      'Wednesday, March 10, 7 a.m.',
      'Wednesday, August 11',
      'Wednesday, September 8, 9 a.m.',
    ]) {
      expect({ quote, pinned: pinYearByWeekday(quote, february, season) }).toEqual({
        quote,
        pinned: null,
      });
    }
    expect(pinYearByWeekday('Wednesday, December 8, 7 a.m.', february, season)).toEqual({
      date: '2027-12-08',
      time: '07:00',
    });
  });
});
