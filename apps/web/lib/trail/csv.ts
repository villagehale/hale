import type { TrailView } from '~/lib/dashboard/mappers';

/**
 * Serializes the (already teen-redacted) trail rows the user is looking at into a
 * CSV string. Operates on the VIEW rows the page renders, so a redacted teen row
 * exports its placeholder, never raw content (rule #1) — the export can carry
 * nothing the page itself doesn't already show. Each row carries its FULL day
 * (`date`) alongside the time, so an exported line stands on its own without the
 * on-screen day grouping; and the domain noun + deep link, never a raw table/id.
 */

export const TRAIL_CSV_HEADER = ['date', 'time', 'actor', 'record', 'summary', 'link'] as const;

/** RFC-4180 quoting: wrap in quotes and double any embedded quote so commas, quotes, and newlines survive. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function trailToCsv(entries: readonly TrailView[]): string {
  const rows = entries.map((entry) =>
    [entry.date, entry.time, entry.actor, entry.noun, entry.summary, entry.link ?? '']
      .map(csvCell)
      .join(','),
  );
  return [TRAIL_CSV_HEADER.join(','), ...rows].join('\n');
}
