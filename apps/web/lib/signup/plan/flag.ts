/**
 * VIL-558 · the day-before-plan lane's own kill switch. Off unless
 * REGISTRATION_PLAN_RUN_ENABLED is exactly `true`: `true\n` (a piped `echo` into
 * `vercel env add`), `TRUE`, `1` and `on` stay off, so no paid run starts that
 * nobody armed. It is separate from AUTHORIZED_SIGNUP_ENABLED and
 * BROWSER_USE_SIGNUP_ENABLED: turning this lane off touches nothing else.
 */
import { isEnabled } from '@hale/flags';

export const REGISTRATION_PLAN_RUN_ENABLED_ENV = 'REGISTRATION_PLAN_RUN_ENABLED';

export function registrationPlanRunEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('registration-plan-run', undefined, env);
}

/**
 * VIL-558 step 6 · the assisted mode's own switch, for ActiveNet towns: Hale joins the open,
 * fills the registration and hands the parent the live browser to submit and pay. Off unless
 * REGISTRATION_ASSISTED_RUN_ENABLED is exactly `true`. It only adds hosts to the plan lane, so
 * the lane's own switch must be on as well.
 */
export const REGISTRATION_ASSISTED_RUN_ENABLED_ENV = 'REGISTRATION_ASSISTED_RUN_ENABLED';

export function registrationAssistedRunEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('registration-assisted-run', undefined, env);
}
