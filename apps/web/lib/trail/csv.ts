import type { TrailView } from '~/lib/dashboard/mappers';

/**
 * Serializes the (already teen-redacted) trail rows the user is looking at into a
 * CSV string. Operates on the VIEW rows the page renders, so a redacted teen row
 * exports its placeholder, never raw content (rule #1) — the export can carry
 * nothing the page itself doesn't already show.
 */

export const TRAIL_CSV_HEADER = ['time', 'actor', 'category', 'summary', 'detail'] as const;

/** RFC-4180 quoting: wrap in quotes and double any embedded quote so commas, quotes, and newlines survive. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function trailToCsv(entries: readonly TrailView[]): string {
  const rows = entries.map((entry) =>
    [entry.time, entry.actor, entry.category, entry.summary, entry.detail].map(csvCell).join(','),
  );
  return [TRAIL_CSV_HEADER.join(','), ...rows].join('\n');
}
