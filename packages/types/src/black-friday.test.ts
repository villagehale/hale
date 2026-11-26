import { describe, expect, it } from 'vitest';
import {
  BLACK_FRIDAY_PRICE_DISPLAY,
  BLACK_FRIDAY_WINDOW_END_ISO,
  BLACK_FRIDAY_WINDOW_END_MS,
  BLACK_FRIDAY_WINDOW_START_ISO,
  blackFridayCountdownClock,
  blackFridayCountdownRemainingMs,
  blackFridayVisitorCountdownEndMs,
  isBlackFridayWindowOpen,
  resolveBlackFridayNow,
} from './black-friday.js';

const OUTSIDE = new Date('2026-11-26T18:00:00.000Z');
const INSIDE = new Date('2026-11-27T15:00:00.000Z');

describe('Black Friday window', () => {
  it('opens at 05:00:00Z on the 27th and closes at 08:00:00Z on the 28th', () => {
    expect(BLACK_FRIDAY_WINDOW_START_ISO).toBe('2026-11-27T05:00:00.000Z');
    expect(BLACK_FRIDAY_WINDOW_END_ISO).toBe('2026-11-28T08:00:00.000Z');
    expect(isBlackFridayWindowOpen(new Date('2026-11-27T04:59:59.000Z'))).toBe(false);
    expect(isBlackFridayWindowOpen(new Date('2026-11-27T05:00:00.000Z'))).toBe(true);
    expect(isBlackFridayWindowOpen(new Date('2026-11-28T07:59:59.000Z'))).toBe(true);
    expect(isBlackFridayWindowOpen(new Date('2026-11-28T08:00:00.000Z'))).toBe(false);
  });

  it('hides an ET countdown at local 23:59:59 while the gate stays open', () => {
    const at = Date.parse('2026-11-28T04:59:59.000Z');
    expect(blackFridayVisitorCountdownEndMs('America/New_York')).toBe(at);
    expect(blackFridayCountdownRemainingMs(at, 'America/New_York')).toBe(0);
    expect(blackFridayCountdownRemainingMs(at - 1000, 'America/New_York')).toBe(1000);
    expect(isBlackFridayWindowOpen(new Date(at))).toBe(true);
  });

  it('formats the countdown as HH:MM:SS, including more than a day and zero', () => {
    expect(blackFridayCountdownClock(0)).toBe('00:00:00');
    expect(blackFridayCountdownClock(-1)).toBe('00:00:00');
    expect(blackFridayCountdownClock((1 * 3600 + 2 * 60 + 3) * 1000 + 999)).toBe('01:02:03');
    const thursdayNoonToronto = Date.parse('2026-11-26T17:00:00.000Z');
    const remaining = blackFridayCountdownRemainingMs(thursdayNoonToronto, 'America/Toronto');
    expect(remaining).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(blackFridayCountdownClock(remaining)).toBe('35:59:59');
  });

  it('caps a Hawaii countdown at the gate end', () => {
    expect(blackFridayVisitorCountdownEndMs('Pacific/Honolulu')).toBe(BLACK_FRIDAY_WINDOW_END_MS);
    expect(
      blackFridayCountdownRemainingMs(BLACK_FRIDAY_WINDOW_END_MS - 1000, 'Pacific/Honolulu'),
    ).toBe(1000);
    expect(blackFridayCountdownRemainingMs(BLACK_FRIDAY_WINDOW_END_MS, 'Pacific/Honolulu')).toBe(0);
    expect(isBlackFridayWindowOpen(new Date(BLACK_FRIDAY_WINDOW_END_MS - 1000))).toBe(true);
    expect(isBlackFridayWindowOpen(new Date(BLACK_FRIDAY_WINDOW_END_MS))).toBe(false);
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
