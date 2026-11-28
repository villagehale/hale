import type { BillingCurrency } from './promo.js';

/**
 * Black Friday 2026 price gate.
 *
 * Half-open [2026-11-27T05:00:00Z, 2026-12-01T08:00:00Z): Friday 00:00
 * America/Toronto through Monday 23:59:59 America/Los_Angeles. Checkout,
 * the bar, and the price a new session charges all read this window.
 * The visitor countdown is separate: Monday 23:59:59 in their own zone,
 * and never later than this gate end.
 *
 * Display amounts are whole dollars. Checkout charges the Stripe price ids in
 * env and never trusts these numbers. A missing id falls back to the regular
 * yearly price; this module only answers "is the window open?"
 */

export const BLACK_FRIDAY_WINDOW_START_ISO = '2026-11-27T05:00:00.000Z';
export const BLACK_FRIDAY_WINDOW_END_ISO = '2026-12-01T08:00:00.000Z';

export const BLACK_FRIDAY_WINDOW_START_MS = Date.parse(BLACK_FRIDAY_WINDOW_START_ISO);
export const BLACK_FRIDAY_WINDOW_END_MS = Date.parse(BLACK_FRIDAY_WINDOW_END_ISO);

/** Monday 30 Nov 2026, 23:59:59, as a wall clock in the visitor's zone. */
export const BLACK_FRIDAY_LOCAL_FRIDAY_END = {
  year: 2026,
  month: 11,
  day: 30,
  hour: 23,
  minute: 59,
  second: 59,
} as const;

export const BLACK_FRIDAY_NOW_OVERRIDE_ENV = 'BLACK_FRIDAY_NOW_OVERRIDE';

/** Whole-dollar yearly amounts charged by the four BF Stripe prices. */
export const BLACK_FRIDAY_PRICE_DISPLAY: Record<
  'plus' | 'family',
  Record<BillingCurrency, { amount: number; banner: string; perYear: string }>
> = {
  plus: {
    CAD: { amount: 39, banner: '$39', perYear: '$39/yr' },
    USD: { amount: 29, banner: '$29', perYear: '$29/yr' },
  },
  family: {
    CAD: { amount: 59, banner: '$59', perYear: '$59/yr' },
    USD: { amount: 49, banner: '$49', perYear: '$49/yr' },
  },
};

/** Inclusive start, exclusive end. `07:59:59Z` on Dec 1 is on; `08:00:00Z` is off. */
export function isBlackFridayWindowOpen(now: Date): boolean {
  const t = now.getTime();
  return t >= BLACK_FRIDAY_WINDOW_START_MS && t < BLACK_FRIDAY_WINDOW_END_MS;
}

export function parseBlackFridayInstant(raw: string | null | undefined): Date | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * Clock for the sale.
 *
 * `now` is the real server time (tests inject it). Production ignores
 * BLACK_FRIDAY_NOW_OVERRIDE, `bf`, and `bf_now`. Outside production, a
 * parseable `bf_now` wins, then `bf=1` forces the window start, then the env
 * override. Anything unparseable is skipped.
 */
export function resolveBlackFridayNow(input: {
  now: Date;
  env?: Record<string, string | undefined>;
  bf?: string | null;
  bfNow?: string | null;
}): Date {
  const env = input.env ?? process.env;
  if (env.VERCEL_ENV === 'production') return input.now;
  const fromQuery = parseBlackFridayInstant(input.bfNow);
  if (fromQuery) return fromQuery;
  if (input.bf?.trim() === '1') return new Date(BLACK_FRIDAY_WINDOW_START_MS);
  const fromEnv = parseBlackFridayInstant(env[BLACK_FRIDAY_NOW_OVERRIDE_ENV]);
  if (fromEnv) return fromEnv;
  return input.now;
}

function timeZoneOffsetMs(timeZone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const pick = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value ?? '0';
    return value === '24' ? 0 : Number(value);
  };
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  );
  return asUtc - instantMs;
}

/** UTC instant of a wall clock in `timeZone`. */
export function zonedWallClockToUtcMs(
  timeZone: string,
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const corrected = guess - timeZoneOffsetMs(timeZone, guess);
  return guess - timeZoneOffsetMs(timeZone, corrected);
}

/**
 * When this visitor's "Ends Friday at midnight" line hits zero.
 * Monday 23:59:59 in `timeZone`, capped at the gate end so a zone west of
 * Pacific (Hawaii) stops at 2026-12-01T08:00:00Z with the gate.
 */
export function blackFridayVisitorCountdownEndMs(timeZone: string): number {
  const local = zonedWallClockToUtcMs(timeZone, BLACK_FRIDAY_LOCAL_FRIDAY_END);
  return Math.min(local, BLACK_FRIDAY_WINDOW_END_MS);
}

/** Milliseconds until the visitor countdown hides. Zero or less means hide it. */
export function blackFridayCountdownRemainingMs(nowMs: number, timeZone: string): number {
  return blackFridayVisitorCountdownEndMs(timeZone) - nowMs;
}

/**
 * Remaining time as `HH:MM:SS`. Hours are not folded into days, so a Thursday
 * visitor can see more than 24. Zero and anything already past are `00:00:00`.
 */
export function blackFridayCountdownClock(remainingMs: number): string {
  const totalSeconds =
    Number.isFinite(remainingMs) && remainingMs > 0 ? Math.floor(remainingMs / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
