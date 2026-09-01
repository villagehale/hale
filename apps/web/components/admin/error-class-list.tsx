'use client';

import { useState } from 'react';
import type { ErrorClass } from '~/lib/admin/queries/error-classes';
import type { AdminErrorRow } from '~/lib/admin/queries/errors';
import { fillWindow, lastDays } from '~/lib/admin/window';
import { DataTable } from './data-table';
import { SparkBars } from './spark-bars';
import { useWindowDays } from './window-dial';

/**
 * The Operations landing: failure CLASSES ranked by window count — brick dot,
 * mono code, human label, Georgia total, frequency sparkline, last-seen. The
 * raw rows are the drill-down (a native <details> per class opens that class's
 * rows only), not the landing; the full merged table is demoted to a collapsed
 * foot section.
 */
export type ClassSort = 'count' | 'last';

export interface VisibleClass {
  cls: ErrorClass;
  windowCount: number;
}

/** Pure: a class's count inside the dial window. Twilio classes have no
 * day-complete history — their page total stands as-is. */
export function windowCount(cls: ErrorClass, days: number): number {
  if (!cls.sparkline) return cls.total;
  const inWindow = new Set(lastDays(days));
  return cls.days.reduce((sum, d) => (inWindow.has(d.day) ? sum + d.count : sum), 0);
}

/** Pure: filter (code + label), window-slice, drop zero-count classes, rank. */
export function visibleClasses(
  classes: readonly ErrorClass[],
  days: number,
  sort: ClassSort,
  filter: string,
): VisibleClass[] {
  const needle = filter.trim().toLowerCase();
  return classes
    .filter(
      (cls) =>
        needle === '' ||
        cls.code.toLowerCase().includes(needle) ||
        cls.label.toLowerCase().includes(needle),
    )
    .map((cls) => ({ cls, windowCount: windowCount(cls, days) }))
    .filter((v) => v.windowCount > 0)
    .sort((a, b) =>
      sort === 'count' ? b.windowCount - a.windowCount : (a.cls.lastAt < b.cls.lastAt ? 1 : -1),
    );
}

/** Pure: the raw rows belonging to one class. Message rows share the class's
 * "<channel> send failed" summary prefix; agent rows lead with the agent name. */
export function rowsForClass(cls: ErrorClass, rows: readonly AdminErrorRow[]): AdminErrorRow[] {
  return rows.filter((row) => {
    if (row.source !== cls.source || row.code !== cls.code) return false;
    if (cls.source === 'message') return row.summary.startsWith(cls.label);
    if (cls.source === 'agent') return row.summary.startsWith(`${cls.label} ·`);
    return true; // twilio: source + code is the class
  });
}

/** Pure: the empty-window line that still orients — 365d classes make the last
 * failure computable even when the window itself is clean. */
export function emptyLine(classes: readonly ErrorClass[]): string {
  if (classes.length === 0) return 'No failures on record.';
  const lastAt = classes.reduce((max, cls) => (cls.lastAt > max ? cls.lastAt : max), '');
  return `No failures in this window. The last failure was ${lastSeenFormat.format(new Date(lastAt))}.`;
}

const lastSeenFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const RAW_COLUMNS = [
  { key: 'at', label: 'time', time: true },
  { key: 'source', label: 'source', dot: true },
  { key: 'code', label: 'code', mono: true },
  { key: 'summary', label: 'summary' },
];

export function ErrorClassList({
  classes,
  rawRows,
}: {
  classes: ErrorClass[];
  rawRows: AdminErrorRow[];
}) {
  const days = useWindowDays();
  const [sort, setSort] = useState<ClassSort>('count');
  const [filter, setFilter] = useState('');
  const visible = visibleClasses(classes, days, sort, filter);

  return (
    <div>
      <div className="adm-class-controls">
        <input
          type="search"
          className="adm-filter"
          placeholder="filter classes…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter failure classes"
        />
        <div className="adm-class-sort" role="group" aria-label="Sort failure classes">
          <button
            type="button"
            aria-pressed={sort === 'count'}
            onClick={() => setSort('count')}
          >
            by count
          </button>
          <button type="button" aria-pressed={sort === 'last'} onClick={() => setSort('last')}>
            by last-seen
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="adm-state">{filter ? 'No classes match the filter.' : emptyLine(classes)}</p>
      ) : (
        <div className="adm-class-list">
          {visible.map(({ cls, windowCount: count }) => (
            <details key={`${cls.source}-${cls.label}-${cls.code}`} className="adm-class">
              <summary>
                <span className="adm-dot adm-dot-fail" />
                <span className="adm-mono">{cls.code}</span>
                <span className="adm-class-label" title={cls.label}>
                  {cls.label}
                </span>
                <span className="adm-num adm-class-total">{count}</span>
                <span className="adm-class-spark">
                  {cls.sparkline ? (
                    <SparkBars
                      counts={fillWindow(cls.days, days, { count: 0 }).map((d) => d.count)}
                      label={`${count} failures over ${days} days`}
                    />
                  ) : (
                    <span className="adm-class-nospark">
                      spark unavailable — Twilio returns latest page only
                    </span>
                  )}
                </span>
                <span className="adm-class-last">
                  {lastSeenFormat.format(new Date(cls.lastAt))}
                </span>
              </summary>
              <DataTable
                rows={rowsForClass(cls, rawRows).map((row) => ({ ...row }))}
                columns={RAW_COLUMNS}
                initialSort={{ key: 'at', desc: true }}
                filterPlaceholder="filter rows…"
              />
            </details>
          ))}
        </div>
      )}

      <details className="adm-details">
        <summary>All raw rows (latest 50 per source · 30d)</summary>
        <DataTable
          rows={rawRows.map((row) => ({ ...row }))}
          columns={RAW_COLUMNS}
          initialSort={{ key: 'at', desc: true }}
          filterPlaceholder="filter errors…"
        />
      </details>
    </div>
  );
}
