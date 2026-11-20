import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { acceptCalendarDate } from './calendar-date';

const MODULE = fileURLToPath(new URL('./calendar-date.ts', import.meta.url));

/** Local YYYY-MM-DD of an ISO date-only string in `tz` — the conversion VIL-531 forbids. */
function naiveLocalYmd(isoDay: string, tz: string): string {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const d = new Date(${JSON.stringify(isoDay)});
       process.stdout.write(
         d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
       );`,
    ],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function acceptInTz(value: string, tz: string): string {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '-e',
      `import { acceptCalendarDate } from ${JSON.stringify(MODULE)};
       process.stdout.write(String(acceptCalendarDate(${JSON.stringify(value)})));`,
    ],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('acceptCalendarDate', () => {
  it('keeps May 1, 2016 as 2016-05-01', () => {
    expect(acceptCalendarDate('2016-05-01')).toBe('2016-05-01');
  });

  it('takes the civil date off a datetime and ignores the clock', () => {
    expect(acceptCalendarDate('2016-05-01T00:00:00.000Z')).toBe('2016-05-01');
    expect(acceptCalendarDate('2016-05-01T04:00:00.000Z')).toBe('2016-05-01');
  });

  it('rejects a day that is not a real calendar date', () => {
    expect(acceptCalendarDate('2016-02-31')).toBeNull();
    expect(acceptCalendarDate('May 1, 2016')).toBeNull();
    expect(acceptCalendarDate(null)).toBeNull();
  });

  /**
   * VIL-531. Preview stored May 1 as May 2 after a timezone conversion. The naive
   * local getters of `new Date('2016-05-01')` already disagree across the two
   * servers Hale runs on; this helper must not follow them.
   */
  it.each(['UTC', 'America/Toronto'] as const)(
    'stores 2016-05-01 with no timezone conversion on a %s server',
    (tz) => {
      const naive = naiveLocalYmd('2016-05-01', tz);
      if (tz === 'America/Toronto') expect(naive).toBe('2016-04-30');
      if (tz === 'UTC') expect(naive).toBe('2016-05-01');
      expect(acceptInTz('2016-05-01', tz)).toBe('2016-05-01');
      expect(acceptInTz('2016-05-01T00:00:00.000Z', tz)).toBe('2016-05-01');
    },
  );
});
