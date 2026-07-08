import type { HomeStats } from './api-types';

/**
 * The Home stat-row's three cells, each a big count + a label, with an HONEST zero
 * state (a calm phrase, never a fake "0 logs"). Pure — no RN import, unit-testable
 * off-device. The counts arrive already teen-redacted from the server (rule #1);
 * this only chooses words.
 */

export interface StatCell {
  /** The count to show big, or null when the cell should read its zero phrase. */
  count: number | null;
  /** The line under (or in place of) the count. */
  label: string;
}

export function homeStatCells(stats: HomeStats): StatCell[] {
  return [
    stats.logsThisWeek > 0
      ? {
          count: stats.logsThisWeek,
          label: `${pluralize(stats.logsThisWeek, 'log', 'logs')} this week`,
        }
      : { count: null, label: 'No logs yet this week' },
    stats.upcomingHealth > 0
      ? {
          count: stats.upcomingHealth,
          label: `health ${pluralize(stats.upcomingHealth, 'item', 'items')} coming up`,
        }
      : { count: null, label: 'No health items coming up' },
    stats.savedPlaces > 0
      ? { count: stats.savedPlaces, label: pluralize(stats.savedPlaces, 'saved', 'saved') }
      : { count: null, label: 'Nothing saved yet' },
  ];
}

function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
