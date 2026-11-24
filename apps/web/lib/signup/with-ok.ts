/**
 * VIL-766. The one date the model may name for signing a child up, and whether
 * that signup is live on this turn. The model does not invent a date.
 *
 * `liveNow` is the gate that appends `coach-signup-offer`: authorized signup
 * is exactly `on`, and the registration-plan-run lane is exactly `true`.
 * `BROWSER_USE_SIGNUP_ENABLED` and `BROWSER_USE_SIGNUP_PAYMENT_ENABLED` do not
 * flip it. A promise of a future start stays in the prompt until that offer
 * is the live how.
 */
import { authorizedSignupEnabled } from './flag';
import { registrationPlanRunEnabled } from './plan/flag';

export const SIGNUP_WITH_OK_STARTS_ON = '2026-12-01';

/** Calendar date the start is compared against. Hale's home clock, not UTC. */
const START_ZONE = 'America/Toronto';

export interface SignupWithOkFact {
  /** ISO date. The only start date the model may say. */
  startsOn: typeof SIGNUP_WITH_OK_STARTS_ON;
  /** True only when coach-signup-offer is the live how. */
  liveNow: boolean;
  /** True when `now` is still before `startsOn` on the Toronto calendar. */
  startsInFuture: boolean;
}

export function signupWithOkLiveNow(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return authorizedSignupEnabled(env) && registrationPlanRunEnabled(env);
}

export function signupStartsInFuture(
  now: Date,
  startsOn: string = SIGNUP_WITH_OK_STARTS_ON,
): boolean {
  return calendarDate(now) < startsOn;
}

export function signupWithOkFact(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): SignupWithOkFact {
  return {
    startsOn: SIGNUP_WITH_OK_STARTS_ON,
    liveNow: signupWithOkLiveNow(env),
    startsInFuture: signupStartsInFuture(now),
  };
}

function calendarDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: START_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
