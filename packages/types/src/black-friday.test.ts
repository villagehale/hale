import { describe, expect, it } from 'vitest';
import {
  BLACK_FRIDAY_COUNTDOWN_END_MS,
  BLACK_FRIDAY_PRICE_DISPLAY,
  BLACK_FRIDAY_WINDOW_END_ISO,
  BLACK_FRIDAY_WINDOW_START_ISO,
  blackFridayCountdownLabel,
  isBlackFridayWindowOpen,
  resolveBlackFridayNow,
} from './black-friday.js';

const OUTSIDE = new Date('2026-11-26T18:00:00.000Z');
const INSIDE = new Date('2026-11-27T15:00:00.000Z');

describe('Black Friday window', () => {
  it('opens at 05:00:00Z on the 27th and closes at 05:00:00Z on the 28th', () => {
    expect(BLACK_FRIDAY_WINDOW_START_ISO).toBe('2026-11-27T05:00:00.000Z');
    expect(BLACK_FRIDAY_WINDOW_END_ISO).toBe('2026-11-28T05:00:00.000Z');
    expect(isBlackFridayWindowOpen(new Date('2026-11-27T04:59:59.000Z'))).toBe(false);
    expect(isBlackFridayWindowOpen(new Date('2026-11-27T05:00:00.000Z'))).toBe(true);
    expect(isBlackFridayWindowOpen(new Date('2026-11-28T04:59:59.000Z'))).toBe(true);
    expect(isBlackFridayWindowOpen(new Date('2026-11-28T05:00:00.000Z'))).toBe(false);
  });

  it('counts down to 23:59:59 America/Toronto, one second before the end', () => {
    expect(BLACK_FRIDAY_COUNTDOWN_END_MS).toBe(Date.parse('2026-11-28T04:59:59.000Z'));
    expect(new Date(BLACK_FRIDAY_COUNTDOWN_END_MS).toISOString()).toBe('2026-11-28T04:59:59.000Z');
    const remaining = BLACK_FRIDAY_COUNTDOWN_END_MS - Date.parse(BLACK_FRIDAY_WINDOW_START_ISO);
    expect(blackFridayCountdownLabel(remaining)).toBe('23:59');
    expect(blackFridayCountdownLabel(60_000)).toBe('00:01');
    expect(blackFridayCountdownLabel(59_000)).toBe('00:00');
    expect(blackFridayCountdownLabel(0)).toBeNull();
    expect(blackFridayCountdownLabel(-1)).toBeNull();
  });

  it('pins the four yearly amounts', () => {
    expect(BLACK_FRIDAY_PRICE_DISPLAY.plus.CAD.amount).toBe(39);
    expect(BLACK_FRIDAY_PRICE_DISPLAY.family.CAD.amount).toBe(59);
    expect(BLACK_FRIDAY_PRICE_DISPLAY.plus.USD.amount).toBe(29);
    expect(BLACK_FRIDAY_PRICE_DISPLAY.family.USD.amount).toBe(49);
  });
});

describe('Black Friday clock overrides', () => {
  const forced = {
    BLACK_FRIDAY_NOW_OVERRIDE: INSIDE.toISOString(),
  };

  it('ignores the env override and both query params in production', () => {
    const now = resolveBlackFridayNow({
      now: OUTSIDE,
      env: { VERCEL_ENV: 'production', ...forced },
      bf: '1',
      bfNow: INSIDE.toISOString(),
    });
    expect(now).toBe(OUTSIDE);
    expect(isBlackFridayWindowOpen(now)).toBe(false);
  });

  it('honors bf_now, then bf=1, then the env override outside production', () => {
    expect(
      resolveBlackFridayNow({
        now: OUTSIDE,
        env: { VERCEL_ENV: 'preview', ...forced },
        bf: '1',
        bfNow: '2026-11-27T18:00:00.000Z',
      }).toISOString(),
    ).toBe('2026-11-27T18:00:00.000Z');

    expect(
      resolveBlackFridayNow({
        now: OUTSIDE,
        env: { VERCEL_ENV: 'preview' },
        bf: '1',
      }).toISOString(),
    ).toBe(BLACK_FRIDAY_WINDOW_START_ISO);

    expect(
      resolveBlackFridayNow({
        now: OUTSIDE,
        env: { VERCEL_ENV: 'preview', ...forced },
      }).toISOString(),
    ).toBe(INSIDE.toISOString());
  });

  it('skips an unparseable override and an unparseable bf_now', () => {
    expect(
      resolveBlackFridayNow({
        now: OUTSIDE,
        env: { VERCEL_ENV: 'preview', BLACK_FRIDAY_NOW_OVERRIDE: 'not-a-date' },
        bfNow: 'nope',
      }),
    ).toBe(OUTSIDE);
    expect(
      isBlackFridayWindowOpen(
        resolveBlackFridayNow({
          now: OUTSIDE,
          env: { VERCEL_ENV: 'preview', BLACK_FRIDAY_NOW_OVERRIDE: 'not-a-date' },
          bf: '1',
          bfNow: 'nope',
        }),
      ),
    ).toBe(true);
  });
});
