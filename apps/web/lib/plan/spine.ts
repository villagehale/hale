import type { AuthoredPlanView } from './authored.js';

/**
 * Pure week-spine core for the Plan page. Folds the chronologically-ordered
 * authored plans into a Mon–Sun day-spine scoped to the CURRENT week, an undated
 * "sometime this week" tail, and a settled set (completed, or dated before this
 * week) that rolls out of the default view. I/O-free so it's unit-testable without
 * a request; the page passes the family's "today" and IANA timezone in.
 *
 * All day math is done on `YYYY-MM-DD` calendar-day KEYS, never raw instants:
 *  - "today" is judged in the family's zone (a parent at 11pm ET is on today, not
 *    the server's UTC tomorrow), so the week window is the family's week.
 *  - a plan's scheduledFor is a bare calendar date stored UTC-midnight (entered via
 *    <input type="date">), so its day key is read in UTC — the exact day the parent
 *    typed, never shifted by an offset. Comparing keys as strings keeps the two
 *    consistent without instant arithmetic.
 */

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The seven weekdays rotated to start at the parent's chosen first day (0=Sunday,
 * 1=Monday). weekStartDay 1 returns the Monday-first WEEKDAYS array unchanged (the
 * default, so the spine is byte-identical to before this preference existed);
 * weekStartDay 0 returns Sunday-first (['sunday','monday',…,'saturday']). WEEKDAYS
 * is Monday-indexed (0=Mon…6=Sun), so the rotation offset is measured from Monday.
 */
export function orderedWeekdays(weekStartDay: number): readonly Weekday[] {
  const offset = weekStartDay === 1 ? 0 : 6;
  return WEEKDAYS.map((_, i) => WEEKDAYS[(i + offset) % 7] as Weekday);
}

export interface DayColumn {
  weekday: Weekday;
  /** The calendar-day key (YYYY-MM-DD) this column stands for, in the current week. */
  dateKey: string;
  plans: AuthoredPlanView[];
}

export interface PlanSpine {
  /** Mon–Sun columns for the current week, always seven, in order. */
  days: DayColumn[];
  /** Open plans with no scheduledFor — the "sometime this week" tail. */
  undated: AuthoredPlanView[];
  /** Plans that have left the active week: completed, or dated before this Monday.
   * Dimmed / rolled into the trail rather than shown on the spine. */
  settled: AuthoredPlanView[];
}

/** The calendar-day key (YYYY-MM-DD) `iso` falls on IN `timeZone`. en-CA renders
 * ISO order, so the string sorts and compares as the date it names. */
export function dayKeyIn(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/** 0=Mon … 6=Sun for the weekday `iso` falls on IN `timeZone`. */
export function weekdayIndexIn(iso: string | Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone })
    .format(new Date(iso))
    .toLowerCase();
  return WEEKDAYS.indexOf(name as Weekday);
}

/** Adds `days` to a YYYY-MM-DD key using UTC-noon math (offset-proof — noon can't
 * cross a day boundary via any real IANA offset), returning a new YYYY-MM-DD key. */
export function addDaysToKey(key: string, days: number): string {
  const at = new Date(`${key}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The UTC instant of a family-local wall-clock moment — the inverse of `dayKeyIn`, for
 * callers holding a day key and a `HH:MM` the family said out loud.
 *
 * The offset is measured AT the target moment (format the naive instant in the target
 * zone and in UTC; the machine's own zone cancels out of the difference), so a 4:30pm
 * event resolves against the offset in force at 4:30pm rather than at midnight — which
 * is the one hour a day-start measurement gets wrong on a DST changeover day.
 */
export function zonedLocalInstant(dayKey: string, time: string, timeZone: string): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`zonedLocalInstant: time must be HH:MM, got '${time}'`);
  }
  const naive = new Date(`${dayKey}T${match[1]}:${match[2]}:00Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`zonedLocalInstant: '${dayKey}' is not a YYYY-MM-DD day key`);
  }
  const inZone = new Date(naive.toLocaleString('en-US', { timeZone }));
  const inUtc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(naive.getTime() + (inUtc.getTime() - inZone.getTime()));
}

export interface WeekWindow {
  /** The chosen-first-day (Monday by default) calendar-day key of the week. */
  startKey: string;
  /** The seventh day's calendar-day key (Sunday by default). */
  endKey: string;
  /** All seven day keys in order, first day → last. */
  dayKeys: string[];
}

/**
 * The family-local week `now` falls in, as `YYYY-MM-DD` keys, optionally shifted by
 * `weekOffset` whole weeks — `weekOffset: 1` is the FOLLOWING week (the weekly-plan
 * composer runs Saturday night and composes the UPCOMING week). Pure; built from the
 * same DST-proof key helpers `buildPlanSpine` uses, so a caller filtering other
 * sources into this window can never drift from the spine's own bounds.
 */
export function weekWindow(
  now: Date,
  timeZone: string,
  weekStartDay = 1,
  weekOffset = 0,
): WeekWindow {
  const todayKey = dayKeyIn(now, timeZone);
  const startOffset = weekStartDay === 1 ? 0 : 6;
  const todayPos = (weekdayIndexIn(now, timeZone) - startOffset + 7) % 7;
  const weekStartKey = addDaysToKey(todayKey, -todayPos + weekOffset * 7);
  const dayKeys = Array.from({ length: 7 }, (_, i) => addDaysToKey(weekStartKey, i));
  return { startKey: weekStartKey, endKey: dayKeys[6] as string, dayKeys };
}

/**
 * Builds the current-week spine. `now` is the request instant; `timeZone` is the
 * family's IANA zone. The week runs Monday→Sunday around the family's local today.
 */
export function buildPlanSpine(
  plans: readonly AuthoredPlanView[],
  now: Date,
  timeZone: string,
  weekStartDay = 1,
): PlanSpine {
  const ordered = orderedWeekdays(weekStartDay);
  const { startKey: weekStartKey, endKey: weekEndKey, dayKeys } = weekWindow(
    now,
    timeZone,
    weekStartDay,
  );

  const days: DayColumn[] = ordered.map((weekday, i) => ({
    weekday,
    dateKey: dayKeys[i] as string,
    plans: [],
  }));
  const undated: AuthoredPlanView[] = [];
  const settled: AuthoredPlanView[] = [];

  for (const plan of plans) {
    // A completed plan is settled regardless of its date — it's done.
    if (plan.completedAt) {
      settled.push(plan);
      continue;
    }
    if (plan.scheduledFor === null) {
      undated.push(plan);
      continue;
    }
    // scheduledFor is a bare calendar date stored UTC-midnight — read its day in UTC.
    const planKey = dayKeyIn(plan.scheduledFor, 'UTC');
    if (planKey < weekStartKey) {
      // Past-dated and still open: it has left the active week — settle it.
      settled.push(plan);
      continue;
    }
    const column = days.find((d) => d.dateKey === planKey);
    if (column && planKey <= weekEndKey) {
      column.plans.push(plan);
    } else {
      // Dated beyond this week (future weeks) — surface with the undated tail so a
      // forthcoming plan is never dropped from the default view.
      undated.push(plan);
    }
  }

  return { days, undated, settled };
}

