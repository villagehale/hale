import { describe, expect, it } from 'vitest';
import { checkbackTiming, nextDayWindow } from './decide';

const ET = 'America/New_York';

describe('nextDayWindow', () => {
  it('opens at the quiet floor the next local day and closes a day later', () => {
    // Tuesday 22:40 EST.
    const window = nextDayWindow(new Date('2026-11-11T03:40:00.000Z'), ET);
    expect(window.opensAt.toISOString()).toBe('2026-11-11T13:00:00.000Z'); // Wed 08:00 EST
    expect(window.closesAt.toISOString()).toBe('2026-11-12T13:00:00.000Z'); // Thu 08:00 EST
  });

  it('counts the next day from the local date, so a 00:30 ask waits a whole day', () => {
    // Wednesday 00:30 EST: the local day is Wednesday, so the next day is Thursday.
    const window = nextDayWindow(new Date('2026-11-11T05:30:00.000Z'), ET);
    expect(window.opensAt.toISOString()).toBe('2026-11-12T13:00:00.000Z'); // Thu 08:00 EST
    expect(window.closesAt.toISOString()).toBe('2026-11-13T13:00:00.000Z'); // Fri 08:00 EST
  });

  it('keeps 08:00 on the wall clock across the spring-forward night', () => {
    // Saturday 20:00 EST; clocks go forward at 02:00 Sunday.
    const window = nextDayWindow(new Date('2027-03-14T01:00:00.000Z'), ET);
    expect(window.opensAt.toISOString()).toBe('2027-03-14T12:00:00.000Z'); // Sun 08:00 EDT
    expect(window.closesAt.toISOString()).toBe('2027-03-15T12:00:00.000Z'); // Mon 08:00 EDT
  });
});

describe('checkbackTiming', () => {
  const anchor = new Date('2026-11-11T03:40:00.000Z');
  const opensAt = Date.parse('2026-11-11T13:00:00.000Z');
  const closesAt = Date.parse('2026-11-12T13:00:00.000Z');
  const at = (ms: number) => checkbackTiming({ anchor, timeZone: ET, now: new Date(ms) });

  it('is too soon until the window opens', () => {
    expect(at(opensAt - 1)).toEqual({ due: false, reason: 'too_soon' });
  });

  it('is due from the opening instant until just before it closes', () => {
    expect(at(opensAt)).toMatchObject({ due: true });
    expect(at(closesAt - 1)).toEqual({
      due: true,
      opensAt: new Date(opensAt),
      closesAt: new Date(closesAt),
    });
  });

  it('is past its day from the closing instant on', () => {
    expect(at(closesAt)).toEqual({ due: false, reason: 'past_day' });
  });
});
