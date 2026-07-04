import type { AuthoredPlanView } from './authored.js';
import type { RoutineItemView } from '../village/mappers.js';

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
    if (planKey < mondayKey) {
      // Past-dated and still open: it has left the active week — settle it.
      settled.push(plan);
      continue;
    }
    const column = days.find((d) => d.dateKey === planKey);
    if (column && planKey <= sundayKey) {
      column.plans.push(plan);
    } else {
      // Dated beyond this week (future weeks) — surface with the undated tail so a
      // forthcoming plan is never dropped from the default view.
      undated.push(plan);
    }
  }

  return { days, undated, settled };
}

/** One weekday strip of the village routine: the weekday it sits on (null = the
 * item was persisted before the day was captured), and its items in input order. */
export interface RoutineDayStrip {
  weekday: Weekday | null;
  items: RoutineItemView[];
}

/**
 * Groups routine items into a light week strip: Monday→Sunday buckets in order,
 * then a trailing null-day ("anytime") bucket for pre-day rows. Only non-empty
 * strips are returned, so the strip shows just the days that carry an item. A
 * routine item's `day` is a weekday label, not PII (it survives teen redaction), so
 * grouping on it is safe. Pure — unit-tested without the page.
 */
export function groupRoutineByDay(items: readonly RoutineItemView[]): RoutineDayStrip[] {
  const byDay = new Map<Weekday, RoutineItemView[]>();
  const anytime: RoutineItemView[] = [];

  for (const item of items) {
    const weekday = WEEKDAYS.find((w) => w === item.day);
    if (weekday) {
      const bucket = byDay.get(weekday) ?? [];
      bucket.push(item);
      byDay.set(weekday, bucket);
    } else {
      anytime.push(item);
    }
  }

  const strips: RoutineDayStrip[] = [];
  for (const weekday of WEEKDAYS) {
    const bucket = byDay.get(weekday);
    if (bucket && bucket.length > 0) strips.push({ weekday, items: bucket });
  }
  if (anytime.length > 0) strips.push({ weekday: null, items: anytime });
  return strips;
}
