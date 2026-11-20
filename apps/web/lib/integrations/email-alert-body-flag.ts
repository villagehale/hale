import { isEnabled } from '@hale/flags';

/**
 * VIL-433 · the email-alert writer may read the Gmail body for that one compose.
 *
 * Off unless exactly `true` (no trim): a trailing newline from `vercel env add` stays
 * off. Unset is today's facts-only writer. Needs `EMAIL_ALERT_ENABLED`.
 */
export const EMAIL_ALERT_BODY_ENABLED_ENV = 'EMAIL_ALERT_BODY_ENABLED';

export function emailAlertBodyEnabled(): boolean {
  return isEnabled('email-alert-body');
}
