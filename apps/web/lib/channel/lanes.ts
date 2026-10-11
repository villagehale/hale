/**
 * Per-lane kill switches for proactive sends (VIL-226). Each lane is off unless its
 * variable is exactly `true`; unsetting it stops the lane on the next request.
 */
export type ProactiveLane = 'calendar_alert' | 'parent_calendar_mirror' | 'email_alert';

export const LANE_ENV: Record<ProactiveLane, string> = {
  calendar_alert: 'CALENDAR_ALERT_ENABLED',
  parent_calendar_mirror: 'PARENT_CALENDAR_MIRROR_ENABLED',
  email_alert: 'EMAIL_ALERT_ENABLED',
};

export function laneEnabled(lane: ProactiveLane): boolean {
  return (process.env[LANE_ENV[lane]] ?? '').trim() === 'true';
}
