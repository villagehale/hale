/**
 * VIL-558 · the day-before-plan lane's own kill switch. Off unless
 * REGISTRATION_PLAN_RUN_ENABLED is exactly `true`: `true\n` (a piped `echo` into
 * `vercel env add`), `TRUE`, `1` and `on` stay off, so no paid run starts that
 * nobody armed. It is separate from AUTHORIZED_SIGNUP_ENABLED and
 * BROWSER_USE_SIGNUP_ENABLED: turning this lane off touches nothing else.
 */
export const REGISTRATION_PLAN_RUN_ENABLED_ENV = 'REGISTRATION_PLAN_RUN_ENABLED';

export function registrationPlanRunEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REGISTRATION_PLAN_RUN_ENABLED_ENV] === 'true';
}
