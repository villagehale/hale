import { type FlagKey, isEnabled } from '@hale/flags';

/**
 * Per-lane kill switches for proactive sends (VIL-226). Each lane is off unless its
 * variable is exactly `true`; unsetting it stops the lane on the next request.
 *
 * STRICT equality on the literal 'true', no trim: `vercel env add` from a piped `echo`
 * stores a TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`, and
 * that shape must fail closed. Set it with `printf '%s' true`, and redeploy: the value
 * only takes effect on a fresh deployment.
 *
 * Reads go through {@link isEnabled}. POSTHOG_FLAGS_ENABLED off (the default) keeps
 * the exact env parser; the env value `false`/`off` is the kill once that path is on.
 */
export type ProactiveLane =
  | 'calendar_alert'
  | 'parent_calendar_mirror'
  | 'email_alert'
  | 'travel_brief'
  | 'registration_ladder';

export const LANE_ENV: Record<ProactiveLane, string> = {
  calendar_alert: 'CALENDAR_ALERT_ENABLED',
  parent_calendar_mirror: 'PARENT_CALENDAR_MIRROR_ENABLED',
  email_alert: 'EMAIL_ALERT_ENABLED',
  travel_brief: 'TRAVEL_BRIEF_ENABLED',
  registration_ladder: 'REGISTRATION_LADDER_ENABLED',
};

const LANE_FLAG: Record<ProactiveLane, FlagKey> = {
  calendar_alert: 'calendar-alert',
  parent_calendar_mirror: 'parent-calendar-mirror',
  email_alert: 'email-alert',
  travel_brief: 'travel-brief',
  registration_ladder: 'registration-ladder',
};

export function laneEnabled(lane: ProactiveLane): boolean {
  return isEnabled(LANE_FLAG[lane]);
}
