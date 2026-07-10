import type { AuthoredPlanView } from './api-types';

/**
 * Pure Mon–Sun week-spine core for the native Plan page — the SAME logic the web
 * page's buildPlanSpine runs (apps/web/lib/plan/spine.ts), ported here because the
 * native bundle can't import server code. Folds the chronologically-ordered authored
 * plans into a Mon–Sun day-spine scoped to the CURRENT week, an undated "sometime
 * this week" tail, and a settled set (completed, or dated before this week) that
 * rolls out of the default view. I/O-free so it's unit-testable; the screen passes
 * the request instant + the family's IANA timezone in.
 *
 * All day math is done on `YYYY-MM-DD` calendar-day KEYS, never raw instants:
 *  - "today" is judged in the family's zone (a parent at 11pm ET is on today, not
 *    the server's UTC tomorrow), so the week window is the family's week.
 *  - a plan's scheduledFor is a bare calendar date stored UTC-midnight, so its day
 *    key is read in UTC — the exact day the parent typed, never shifted by an offset.
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
  /** Plans that have left the active week: completed, or dated before this Monday. */
  settled: AuthoredPlanView[];
}

/** The calendar-day key (YYYY-MM-DD) `iso` falls on IN `timeZone`. en-CA renders
 * ISO order, so the string sorts and compares as the date it names. */
function dayKeyIn(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/** 0=Mon … 6=Sun for the weekday `iso` falls on IN `timeZone`. */
function weekdayIndexIn(iso: string | Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone })
    .format(new Date(iso))
    .toLowerCase();
  return WEEKDAYS.indexOf(name as Weekday);
}

/** Adds `days` to a YYYY-MM-DD key using UTC-noon math (offset-proof — noon can't
 * cross a day boundary via any real IANA offset), returning a new YYYY-MM-DD key. */
function addDaysToKey(key: string, days: number): string {
  const at = new Date(`${key}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Builds the current-week spine. `now` is the request instant; `timeZone` is the
 * family's IANA zone. The week runs Monday→Sunday around the family's local today.
 */
export function buildPlanSpine(
  plans: readonly AuthoredPlanView[],
  now: Date,
  timeZone: string,
): PlanSpine {
  const todayKey = dayKeyIn(now, timeZone);
  const mondayKey = addDaysToKey(todayKey, -weekdayIndexIn(now, timeZone));
  const dayKeys = WEEKDAYS.map((_, i) => addDaysToKey(mondayKey, i));
  const sundayKey = dayKeys[6] as string;

  const days: DayColumn[] = WEEKDAYS.map((weekday, i) => ({
    weekday,
    dateKey: dayKeys[i] as string,
    plans: [],
  }));
  const undated: AuthoredPlanView[] = [];
  const settled: AuthoredPlanView[] = [];

  for (const plan of plans) {
    if (plan.completedAt) {
      settled.push(plan);
      continue;
    }
    if (plan.scheduledFor === null) {
      undated.push(plan);
      continue;
    }
    const planKey = dayKeyIn(plan.scheduledFor, 'UTC');
    if (planKey < mondayKey) {
      settled.push(plan);
      continue;
    }
    const column = days.find((d) => d.dateKey === planKey);
    if (column && planKey <= sundayKey) {
      column.plans.push(plan);
    } else {
      undated.push(plan);
    }
  }

  return { days, undated, settled };
}
