/**
 * Per-lane kill switches for proactive sends (VIL-226). Each lane is off unless its
 * variable is exactly `true`; unsetting it stops the lane on the next request.
 *
 * STRICT equality on the literal 'true', no trim: `vercel env add` from a piped `echo`
 * stores a TRAILING NEWLINE, so a value that prints as `true` is really `'true\n'`, and
 * that shape must fail closed. Set it with `printf '%s' true`, and redeploy: the value
 * only takes effect on a fresh deployment.
 */
export type ProactiveLane = 'calendar_alert' | 'parent_calendar_mirror' | 'email_alert' | 'travel_brief';

export const LANE_ENV: Record<ProactiveLane, string> = {
  calendar_alert: 'CALENDAR_ALERT_ENABLED',
  parent_calendar_mirror: 'PARENT_CALENDAR_MIRROR_ENABLED',
  email_alert: 'EMAIL_ALERT_ENABLED',
  travel_brief: 'TRAVEL_BRIEF_ENABLED',
};

export function laneEnabled(lane: ProactiveLane): boolean {
  return process.env[LANE_ENV[lane]] === 'true';
}
