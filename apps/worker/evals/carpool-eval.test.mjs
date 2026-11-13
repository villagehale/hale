import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARPOOL_EVAL_CLOCKS,
  CARPOOL_READING_FIXTURES,
  gradeCarpoolReading,
} from './carpool-reading-fixtures.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function readingFor(expect) {
  return {
    intent: expect.intent[0],
    driverName: expect.driverName === null ? null : expect.driverName[0],
    driverIsSender: expect.driverIsSender ?? false,
    pickupDate: expect.pickupDate,
    pickupTime: expect.pickupTime ?? null,
  };
}

function localWeekday(instant, timeZone, plusDays = 0) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant);
  const next = new Date(`${day}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + plusDays);
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(next);
}

describe('carpool reader eval fixtures', () => {
  it('reads every fixture on one of the suite fixed clocks', () => {
    const clocks = new Set(Object.values(CARPOOL_EVAL_CLOCKS));
    for (const fixture of CARPOOL_READING_FIXTURES) {
      expect(clocks.has(fixture.input.now), fixture.id).toBe(true);
    }
  });

  it('holds a case where tomorrow and Saturday are different days, and expects no date', () => {
    const fixture = CARPOOL_READING_FIXTURES.find((f) => f.id === 'tomorrow-saturday-disagree');
    expect(fixture).toBeDefined();
    const { now, timeZone } = fixture.input;
    expect(localWeekday(now, timeZone, 1)).not.toBe('Saturday');
    expect(fixture.expect.pickupDate).toBeNull();
    expect(fixture.expect.pickupAt).toBeNull();
  });

  it('holds the Friday-night case where UTC has already turned Saturday', () => {
    const fixture = CARPOOL_READING_FIXTURES.find((f) => f.id === 'tomorrow-saturday-friday-night');
    const { now, timeZone } = fixture.input;
    expect(localWeekday(now, timeZone)).toBe('Friday');
    expect(now.getUTCDay()).toBe(6);
    expect(fixture.expect.pickupAt).toBe('2026-10-31T12:00:00.000Z');
  });
});

describe('gradeCarpoolReading', () => {
  it('passes every fixture on its own expected reading', () => {
    for (const fixture of CARPOOL_READING_FIXTURES) {
      const failures = gradeCarpoolReading(fixture.expect, {
        reading: readingFor(fixture.expect),
        pickupAt: fixture.expect.pickupAt,
      });
      expect(failures, fixture.id).toEqual([]);
    }
  });

  it('fails a reader that guesses Saturday when tomorrow is Monday', () => {
    const fixture = CARPOOL_READING_FIXTURES.find((f) => f.id === 'tomorrow-saturday-disagree');
    const failures = gradeCarpoolReading(fixture.expect, {
      reading: { ...readingFor(fixture.expect), pickupDate: '2026-11-07' },
      pickupAt: '2026-11-07T13:00:00.000Z',
    });
    expect(failures).toEqual(['pickupDate="2026-11-07"', 'pickupAt=2026-11-07T13:00:00.000Z']);
  });

  it('fails the old UTC-day reading of Friday-night "tomorrow Saturday 8am"', () => {
    const fixture = CARPOOL_READING_FIXTURES.find((f) => f.id === 'tomorrow-saturday-friday-night');
    const failures = gradeCarpoolReading(fixture.expect, {
      reading: { ...readingFor(fixture.expect), pickupDate: '2026-11-01', pickupTime: '07:00' },
      pickupAt: '2026-11-01T12:00:00.000Z',
    });
    expect(failures).toEqual([
      'pickupDate="2026-11-01"',
      'pickupTime="07:00"',
      'pickupAt=2026-11-01T12:00:00.000Z',
    ]);
  });

  it('fails a wrong intent or a stale driver', () => {
    const fixture = CARPOOL_READING_FIXTURES.find((f) => f.id === 'driver-swap');
    const failures = gradeCarpoolReading(fixture.expect, {
      reading: { ...readingFor(fixture.expect), intent: 'chatter', driverName: 'Maya' },
      pickupAt: fixture.expect.pickupAt,
    });
    expect(failures).toEqual(['intent=chatter', 'driverName="Maya"']);
  });
});

describe('carpool eval wiring', () => {
  it('replays the recorded cache in CI, not the estimate', () => {
    const pkg = JSON.parse(read('../package.json'));
    expect(pkg.scripts['eval:carpool']).toBe('node evals/carpool-eval.mjs --cached-only');
    const ci = read('../../../.github/workflows/ci.yml');
    expect(ci).toMatch(/run: pnpm --filter @hale\/worker eval:carpool\n/);
  });
});
