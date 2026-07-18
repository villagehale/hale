/**
 * Typed placeholder content for Companion surfaces the prototype shows but which have
 * NO honest backend semantics yet (Global Constraint 6: stub-data lives here, typed,
 * never invented inline). Every export is a documented substitution — replace each
 * with a real source before treating it as truth. See task-7-report.md.
 */

/**
 * The Growth "overview" verdict + reference line (Growth tab). STUB: Hale does NOT
 * compute WHO percentiles — there is deliberately no server-side growth derivation
 * (a plain record of readings, not a clinical assessment). These are the prototype's
 * placeholder labels; the accompanying caveat copy keeps the screen honest until a
 * real percentile computation exists. Do not treat "On track" as a clinical verdict.
 */
export const GROWTH_VERDICT = 'On track' as const;
export const GROWTH_DATA_SOURCE = 'WHO Growth Standards' as const;

/** One row of the suggested daily rhythm (Routines → Daily). */
export interface SuggestedRoutineRow {
  /** Local clock label, e.g. "7:00 AM". */
  time: string;
  label: string;
}

/**
 * A suggested daily rhythm (Routines → Daily). STUB: there is no per-child daily
 * routine backend — nothing here is tailored to the child or tracked. Rendered as an
 * illustrative starting point with an explicit "not tracked yet" note; the real,
 * honest routine (Hale's weekly proposal) lives under the Weekly pill. Mirrors the
 * prototype's example toddler day.
 */
export const SUGGESTED_DAILY_ROUTINE: readonly SuggestedRoutineRow[] = [
  { time: '7:00 AM', label: 'Wake up' },
  { time: '7:30 AM', label: 'Breakfast' },
  { time: '9:00 AM', label: 'Play time' },
  { time: '10:30 AM', label: 'Nap' },
  { time: '12:30 PM', label: 'Lunch' },
  { time: '3:00 PM', label: 'Snack' },
  { time: '6:00 PM', label: 'Dinner' },
  { time: '7:30 PM', label: 'Bedtime' },
];
