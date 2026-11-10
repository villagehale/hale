/**
 * VIL-569 — a quiet-hours hold on an email alert is a debt the sweep re-offers.
 *
 * Off unless EMAIL_ALERT_HOLD_DEBT_ENABLED is exactly `true`. A trailing newline
 * from `vercel env add`, `TRUE`, `on`, and `1` stay off. Unset stays off. Needs
 * EMAIL_ALERT_ENABLED and migration 0225. Unlit, a quiet-hours hold is still a
 * receipt and nothing is re-offered.
 */
export const EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV = 'EMAIL_ALERT_HOLD_DEBT_ENABLED';

export function emailAlertHoldDebtEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV] === 'true';
}
