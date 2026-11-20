import { isEnabled } from '@hale/flags';

/**
 * VIL-707. A turn whose opt-out read failed is not handed to the coach.
 * Exactly `true`. `true\n`, `TRUE`, and unset stay on today's path.
 */
export const OPT_OUT_UNREAD_HOLD_TURN_ENV = 'OPT_OUT_UNREAD_HOLD_TURN_ENABLED';

/** VIL-707. A hold write that throws ends the turn. Exactly `true`. */
export const OPT_OUT_HOLD_WRITE_STOPS_TURN_ENV = 'OPT_OUT_HOLD_WRITE_STOPS_TURN_ENABLED';

export function optOutUnreadHoldTurnEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('opt-out-unread-hold-turn', undefined, env);
}

export function optOutHoldWriteStopsTurnEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('opt-out-hold-write-stops-turn', undefined, env);
}
