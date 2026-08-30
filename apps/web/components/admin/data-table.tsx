'use client';

import {
  type ColumnDef,
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';

/**
 * The one headless-table wrapper (@tanstack/react-table v9), styled entirely
 * in the admin tokens. Serializable-only props across the RSC boundary:
 * columns are key/label descriptors, never component or accessor functions —
 * cell affordances (mono, time, dot, link) are declared as flags and rendered
 * here on the client.
 */
export interface AdmColumn {
  key: string;
  label: string;
  mono?: boolean;
  /** ISO string → short Toronto-local display, sorted by the raw value. */
  time?: boolean;
  /** Prefix a brick status dot (failure vocabulary). */
  dot?: boolean;
  /** Render the value as an external link labelled `label`. */
  link?: boolean;
}

export type AdmRow = Record<string, string | number | null>;

const PAGE_SIZE = 25;

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric },
});

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function cellText(column: AdmColumn, value: string | number | null): string {
  if (value === null || value === '') return '—';
  if (column.time && typeof value === 'string') {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? value : timeFormat.format(at);
  }
  return String(value);
}

export function DataTable({
  rows,
  columns,
  filterPlaceholder,
  initialSort,
}: {
  rows: AdmRow[];
  columns: AdmColumn[];
  filterPlaceholder?: string;
  initialSort?: { key: string; desc: boolean };
}) {
  const [globalFilter, setGlobalFilter] = useState('');
  const columnDefs = useMemo(
    (): ColumnDef<typeof features, AdmRow>[] =>
      columns.map((column) => ({
        id: column.key,
        accessorKey: column.key,
        header: column.label,
        sortFn: 'alphanumeric',
      })),
    [columns],
  );

  const table = useTable({
    features,
    data: rows,
    columns: columnDefs,
    globalFilterFn: 'includesString',
    initialState: {
      pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
      sorting: initialSort ? [{ id: initialSort.key, desc: initialSort.desc }] : [],
    },
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
  });

  const pageRows = table.getRowModel().rows;
  const total = table.getFilteredRowModel().rows.length;
  const paged = rows.length > PAGE_SIZE;

  return (
    <div>
      <input
        type="search"
        className="adm-filter"
        placeholder={filterPlaceholder ?? 'filter as you type…'}
        value={globalFilter}
        onChange={(event) => setGlobalFilter(event.target.value)}
        aria-label="Filter table rows"
      />
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              {table.getHeaderGroups().map((group) =>
                group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'
                      }
                    >
                      <button
                        type="button"
                        className="adm-th-sort"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {String(header.column.columnDef.header ?? header.id)}
                        {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
                      </button>
                    </th>
                  );
                }),
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="adm-state">
                  No rows.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => {
                    const value = row.original[column.key] ?? null;
                    if (column.link && typeof value === 'string' && value) {
                      return (
                        <td key={column.key}>
                          <a href={value} target="_blank" rel="noreferrer">
                            open ↗
                          </a>
                        </td>
                      );
                    }
                    return (
                      <td key={column.key} className={column.mono ? 'adm-mono' : undefined}>
                        {column.dot ? <span className="adm-dot adm-dot-fail" /> : null}
                        {cellText(column, value)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {paged ? (
        <div className="adm-pager">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            ‹ prev
          </button>
          <span>
            {(table.state.pagination?.pageIndex ?? 0) + 1} / {Math.max(1, table.getPageCount())} ·{' '}
            {total} rows
          </span>
          <button type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            next ›
          </button>
        </div>
      ) : null}
    </div>
  );
}
