import { isEnabled } from '@hale/flags';

/**
 * VIL-762 · one alert per real appointment, and a clash with a known commitment
 * is named in that alert.
 *
 * Off unless exactly `true` (no trim): a trailing newline from `vercel env add`
 * stays off. Unset keeps today's per-thread occasion key and a notice that is
 * not told about other commitments.
 */
export const EMAIL_ALERT_ONCE_ENABLED_ENV = 'EMAIL_ALERT_ONCE_ENABLED';

export function emailAlertOnceEnabled(): boolean {
  return isEnabled('email-alert-once');
}
