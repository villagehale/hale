import type { BillingCurrency } from './promo.js';

/**
 * Black Friday 2026, one Toronto day.
 *
 * The window is [2026-11-27T05:00:00Z, 2026-11-28T05:00:00Z): midnight to
 * midnight America/Toronto on Friday 27 Nov, which is EST (UTC−5) that week.
 * The countdown target is the last second inside it, 23:59:59 local, one
 * second before the exclusive end.
 *
 * Display amounts are whole dollars. Checkout charges the Stripe price ids in
 * env and never trusts these numbers. A missing id falls back to the regular
 * yearly price; this module only answers "is the window open?"
 */

export const BLACK_FRIDAY_WINDOW_START_ISO = '2026-11-27T05:00:00.000Z';
export const BLACK_FRIDAY_WINDOW_END_ISO = '2026-11-28T05:00:00.000Z';

export const BLACK_FRIDAY_WINDOW_START_MS = Date.parse(BLACK_FRIDAY_WINDOW_START_ISO);
export const BLACK_FRIDAY_WINDOW_END_MS = Date.parse(BLACK_FRIDAY_WINDOW_END_ISO);
/** 23:59:59 America/Toronto. The window stays open for the following second. */
export const BLACK_FRIDAY_COUNTDOWN_END_MS = BLACK_FRIDAY_WINDOW_END_MS - 1000;

export const BLACK_FRIDAY_NOW_OVERRIDE_ENV = 'BLACK_FRIDAY_NOW_OVERRIDE';

/** Whole-dollar yearly amounts charged by the four BF Stripe prices. */
export const BLACK_FRIDAY_PRICE_DISPLAY: Record<
  'plus' | 'family',
  Record<BillingCurrency, { amount: number; banner: string; perYear: string }>
> = {
  plus: {
    CAD: { amount: 39, banner: 'C$39', perYear: '$39/yr' },
    USD: { amount: 29, banner: 'US$29', perYear: '$29/yr' },
  },
  family: {
    CAD: { amount: 59, banner: 'C$59', perYear: '$59/yr' },
    USD: { amount: 49, banner: 'US$49', perYear: '$49/yr' },
  },
};

/** Inclusive start, exclusive end. `04:59:59Z` on the 27th is off; `05:00:00Z` is on. */
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

/** Hours and minutes until `endsAt`. Null once the countdown has hit zero. */
export function blackFridayCountdownLabel(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
