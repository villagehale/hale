import { weekdayIndexIn } from '~/lib/plan/spine';

/**
 * Per-family-local send-window scheduling for the weekly-plan cron (VIL-217).
 *
 * The digest cron cheats: one fixed UTC instant (12:00) fires every family at once,
 * and it dates every brief to Toronto. The weekly plan must instead run at each
 * family's OWN local send window (default Saturday 19:30, so Sunday delivery has a
 * day of slack). An hourly cron sweeps all families; this module decides, per family,
 * whether NOW is that family's window — read entirely in the family's IANA zone via
 * Intl (never raw Date.getDay/getHours, which are UTC on the server).
 */

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 10080;

export interface SendWindow {
  /** 0 = Monday … 6 = Sunday (matches spine's weekdayIndexIn). */
  weekday: number;
  /** Family-local hour, 0–23. */
  hour: number;
  /** Family-local minute, 0–59. */
  minute: number;
}

/**
 * Default window: Saturday 19:30 family-local. The composer runs Saturday evening so
 * the Sunday-morning delivery (B2) has a full day of slack to recompute on a late
 * change. VIL-216's per-family override (when its prefs table lands) replaces this via
 * resolveSendWindow; until then every family uses the default.
 */
export const DEFAULT_SEND_WINDOW: SendWindow = { weekday: 5, hour: 19, minute: 30 };

/** Family-local {hour, minute} of `now` in `timeZone`, read via formatToParts so the
 * clock is numeric — avoiding the `'24'`-at-midnight quirk some engines emit for
 * `hour:'2-digit'` + `hour12:false`. */
function localHourMinute(now: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

/** Minutes since the start of the family-local week (Monday 00:00 = 0). */
function localMinutesOfWeek(now: Date, timeZone: string): number {
  const { hour, minute } = localHourMinute(now, timeZone);
  return weekdayIndexIn(now, timeZone) * MINUTES_PER_DAY + hour * 60 + minute;
}

/**
 * True when `now`, read in `timeZone`, falls in the `[window, window + tickMinutes)`
 * family-local slot. With an hourly cron (`tickMinutes = 60`) exactly ONE tick per
 * week lands in the slot for any family, regardless of UTC offset — including the
 * `:30`/`:45` zones (Newfoundland, Nepal) that a fixed-minute equality check would
 * miss forever. Pure; every field is read in the family zone via Intl.
 *
 * DST note: the slot is one tick wide, so the default 19:30 window (nowhere near the
 * 02:00 transition) is caught exactly once even on the spring-forward / fall-back
 * weekend. The composer's idempotent per-week upsert backstops any pathological
 * double-match.
 */
export function isInSendWindow(
  now: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
  tickMinutes = 60,
): boolean {
  const nowMin = localMinutesOfWeek(now, timeZone);
  const targetMin = window.weekday * MINUTES_PER_DAY + window.hour * 60 + window.minute;
  const delta = (nowMin - targetMin + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return delta < tickMinutes;
}
