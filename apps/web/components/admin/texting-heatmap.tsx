'use client';

import type { TextingHourRow } from '~/lib/admin/queries/texting-hours';
import { EMPTY_WINDOW_LINE } from '~/lib/admin/panel-state';
import { lastDays, WEEKDAY_LABELS, weekdayOfDayKey } from '~/lib/admin/window';
import { useWindowDays } from './window-dial';

/**
 * WHEN families text: weekday × hour-of-day density as a heatmap — a cyclical
 * two-dimensional density is a heatmap, not a line. Single-hue amber opacity
 * ramp on wash (amber is fill-only; no cool-hot gradient breaking the ledger's
 * vocabulary), exact count per cell in the title + aria-label. Dial-sliced
 * client-side; cell opacity transitions 200ms (cut under reduced motion).
 */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Pure: dial-sliced rows folded into a 7×24 weekday/hour grid (Mon-first). */
export function foldHeatmap(rows: readonly TextingHourRow[], days: number): number[][] {
  const inWindow = new Set(lastDays(days));
  const grid = WEEKDAY_LABELS.map(() => HOURS.map(() => 0));
  for (const row of rows) {
    if (!inWindow.has(row.day)) continue;
    const weekday = grid[weekdayOfDayKey(row.day)];
    if (weekday) weekday[row.hour] = (weekday[row.hour] ?? 0) + row.count;
  }
  return grid;
}

export function TextingHeatmap({ rows }: { rows: TextingHourRow[] }) {
  const days = useWindowDays();
  const grid = foldHeatmap(rows, days);
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((sum, count) => sum + count, 0);

  if (total === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;

  return (
    <div className="adm-heatmap-wrap">
      <div className="adm-heatmap" role="img" aria-label={`${total} inbound texts by weekday and hour`}>
        <span className="adm-heatmap-corner" />
        {HOURS.map((hour) => (
          <span key={hour} className="adm-heatmap-hour">
            {hour % 3 === 0 ? hour : ''}
          </span>
        ))}
        {grid.map((weekdayRow, weekday) => {
          const label = WEEKDAY_LABELS[weekday];
          return (
            <div key={label} className="adm-heatmap-row">
              <span className="adm-heatmap-day">{label}</span>
              {weekdayRow.map((count, hour) => {
                const detail = `${label} ${String(hour).padStart(2, '0')}:00 — ${count} ${count === 1 ? 'text' : 'texts'}`;
                return (
                  <span
                    key={hour}
                    className="adm-heatmap-cell"
                    style={{ opacity: count === 0 ? 0.18 : 0.25 + 0.75 * (count / max) }}
                    title={detail}
                    aria-label={detail}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
