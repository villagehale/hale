/**
 * VIL-718 · one takeover link. Off unless TAKEOVER_LINK_ENABLED is exactly `true`: `true\n`
 * (a piped `echo` into `vercel env add`), `TRUE`, `1` and `on` stay off.
 *
 * On, a plan run that stops for a step only the parent can do (a sign-in wall, a code the
 * site sent them, a passkey, a captcha) keeps its browser, and the parent gets one Hale link
 * that opens it. When they tap done, the next sweep picks the same browser session back up.
 * Off, every one of those stops ends the run exactly as before.
 *
 * It turns nothing else on: the plan lane keeps its own switch
 * (REGISTRATION_PLAN_RUN_ENABLED), and the saved-login card keeps PROVIDER_CREDENTIALS_ENABLED.
 */
import { isEnabled } from '@hale/flags';

export const TAKEOVER_LINK_ENABLED_ENV = 'TAKEOVER_LINK_ENABLED';

export function takeoverLinkEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('takeover-link', undefined, env);
}
