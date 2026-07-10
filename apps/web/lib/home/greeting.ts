import type { HomeStats } from './aggregates';

/** Time-of-day phrase — mirrors the mobile `timeGreeting`. */
export function timeGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * "Good evening, Alex" — the time-of-day phrase warmed with the SIGNED-IN parent's
 * first name (the viewer, so a co-parent sees their own name, not the primary slot).
 * A name-less account (preview mode / no session) reads the bare phrase, never a
 * dangling comma. Mirrors the mobile `homeGreeting`.
 */
export function homeGreeting(viewerName: string | null, date: Date = new Date()): string {
  const firstName = viewerName?.trim().split(/\s+/)[0];
  return firstName ? `${timeGreeting(date)}, ${firstName}` : timeGreeting(date);
}

/** One cell of the Home stat row: a big count + a label, or a calm zero phrase. */
export interface StatCell {
  /** The count to show big, or null when the cell should read its zero phrase. */
  count: number | null;
  /** The line under (or in place of) the count. */
  label: string;
}

/**
 * The three honest counts the Home stat row surfaces, each a big count + label with
 * an HONEST zero state (a calm phrase, never a fake "0 logs"). Counts arrive already
 * teen-redacted from the loader (rule #1); this only chooses words. Mirrors the
 * mobile `homeStatCells`.
 */
export function homeStatCells(stats: HomeStats): StatCell[] {
  return [
    stats.logsThisWeek > 0
      ? { count: stats.logsThisWeek, label: `${pluralize(stats.logsThisWeek, 'log', 'logs')} this week` }
      : { count: null, label: 'no logs yet this week' },
    stats.upcomingHealth > 0
      ? {
          count: stats.upcomingHealth,
          label: `health ${pluralize(stats.upcomingHealth, 'item', 'items')} coming up`,
        }
      : { count: null, label: 'no health items coming up' },
    stats.savedPlaces > 0
      ? { count: stats.savedPlaces, label: 'saved' }
      : { count: null, label: 'nothing saved yet' },
  ];
}

function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
