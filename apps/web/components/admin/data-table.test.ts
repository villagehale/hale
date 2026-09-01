import { useTable } from '@tanstack/react-table';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type AdmColumn, type AdmRow, admTableOptions, DataTable } from './data-table';

/**
 * The table is a client island and the admin suite has no DOM, so interaction
 * is driven headlessly through the component's own pipeline (admTableOptions —
 * the same features, column defs and filter fn DataTable mounts): a controlled
 * harness renders it, the REAL header toggle handler is invoked as a click
 * would invoke it, and the resulting state is rendered again. The static render
 * of DataTable itself pins that the pipeline is what the component wires up.
 */
const ROWS: AdmRow[] = [
  { at: '2026-08-03T12:00:00.000Z', source: 'twilio', code: '30003', summary: 'alpine handset unreachable' },
  { at: '2026-08-01T12:00:00.000Z', source: 'send', code: '21610', summary: 'alarm — recipient opted out' },
  { at: '2026-08-02T12:00:00.000Z', source: 'agent_run', code: 'timeout', summary: 'reviewer never answered' },
];

const COLUMNS: AdmColumn[] = [
  { key: 'at', label: 'time', time: true },
  { key: 'source', label: 'source' },
  { key: 'code', label: 'code', mono: true },
  { key: 'summary', label: 'summary' },
];

type Sorting = { id: string; desc: boolean }[];
type Toggle = (event: unknown) => void;

/** `<td class="adm-mono">` is the code column — the rendered row order. */
function renderedCodes(html: string) {
  return [...html.matchAll(/<td class="adm-mono">([^<]*)<\/td>/g)].map((match) => match[1]);
}

function Harness({
  sorting,
  globalFilter,
  onSortingChange,
  onToggle,
}: {
  sorting: Sorting;
  globalFilter: string;
  onSortingChange?: (next: Sorting) => void;
  onToggle?: (toggle: Toggle | undefined) => void;
}) {
  const table = useTable({
    ...admTableOptions(ROWS, COLUMNS),
    state: { sorting, globalFilter },
    onSortingChange: (updater) =>
      onSortingChange?.(typeof updater === 'function' ? updater(sorting) : updater),
  });
  const header = table.getHeaderGroups()[0]?.headers.find((h) => h.column.id === 'source');
  onToggle?.(header?.column.getToggleSortingHandler() as Toggle | undefined);
  return createElement(
    'ul',
    null,
    table.getRowModel().rows.map((row) =>
      createElement('li', { key: row.id }, String(row.original.code)),
    ),
  );
}

function harnessCodes(
  sorting: Sorting,
  globalFilter: string,
  sinks: {
    onSortingChange?: (next: Sorting) => void;
    onToggle?: (toggle: Toggle | undefined) => void;
  } = {},
) {
  const html = renderToStaticMarkup(
    createElement(Harness, { sorting, globalFilter, ...sinks }),
  );
  return [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]);
}

describe('DataTable — sorting', () => {
  it('reorders rows when the sortable header is clicked, and again on the second click', () => {
    let sorting: Sorting = [];
    let toggle: Toggle | undefined;
    const sinks = {
      onSortingChange: (next: Sorting) => {
        sorting = next;
      },
      onToggle: (next: Toggle | undefined) => {
        toggle = next;
      },
    };

    // Unsorted: the rows stand in the order the loader handed them over.
    expect(harnessCodes(sorting, '', sinks)).toEqual(['30003', '21610', 'timeout']);

    expect(typeof toggle).toBe('function');
    toggle?.({ persist: () => {} });
    expect(sorting).toEqual([{ id: 'source', desc: false }]);
    // agent_run < send < twilio.
    expect(harnessCodes(sorting, '', sinks)).toEqual(['timeout', '21610', '30003']);

    toggle?.({ persist: () => {} });
    expect(sorting).toEqual([{ id: 'source', desc: true }]);
    expect(harnessCodes(sorting, '', sinks)).toEqual(['30003', '21610', 'timeout']);
  });

  it('mounts that pipeline in the rendered table — initial sort orders the rows and the header says so', () => {
    const html = renderToStaticMarkup(
      createElement(DataTable, {
        rows: ROWS,
        columns: COLUMNS,
        initialSort: { key: 'source', desc: false },
      }),
    );
    expect(renderedCodes(html)).toEqual(['timeout', '21610', '30003']);
    expect(html).toContain('<th aria-sort="ascending">');
    expect(html).toContain('source ↑');

    const descending = renderToStaticMarkup(
      createElement(DataTable, {
        rows: ROWS,
        columns: COLUMNS,
        initialSort: { key: 'source', desc: true },
      }),
    );
    expect(renderedCodes(descending)).toEqual(['30003', '21610', 'timeout']);
    expect(descending).toContain('<th aria-sort="descending">');
    expect(descending).toContain('source ↓');
  });
});

describe('DataTable — in-cell share bars', () => {
  it('renders a bar column scaled to the column max over ALL rows', () => {
    const html = renderToStaticMarkup(
      createElement(DataTable, {
        rows: [
          { code: 'earlyon', started: 10 },
          { code: 'library', started: 5 },
        ],
        columns: [
          { key: 'code', label: 'source' },
          { key: 'started', label: 'started', bar: true },
        ],
      }),
    );
    expect(html).toContain('adm-cell-bar');
    expect(html).toContain('width:100%');
    expect(html).toContain('width:50%');
  });
});

describe('DataTable — filtering', () => {
  it('narrows the rows as each character is typed, across every column', () => {
    expect(harnessCodes([], '')).toEqual(['30003', '21610', 'timeout']);
    // "al" is in alpine and alarm; "alp" only in alpine.
    expect(harnessCodes([], 'a')).toEqual(['30003', '21610', 'timeout']);
    expect(harnessCodes([], 'al')).toEqual(['30003', '21610']);
    expect(harnessCodes([], 'alp')).toEqual(['30003']);
    expect(harnessCodes([], 'alpx')).toEqual([]);
    // Not summary-only: the filter reaches the source column too.
    expect(harnessCodes([], 'twilio')).toEqual(['30003']);
  });

  it('mounts a filter input bound to that filter state', () => {
    const html = renderToStaticMarkup(
      createElement(DataTable, {
        rows: ROWS,
        columns: COLUMNS,
        filterPlaceholder: 'filter errors…',
      }),
    );
    expect(html).toContain('placeholder="filter errors…"');
    expect(html).toContain('aria-label="Filter table rows"');
    expect(html).toContain('value=""');
    expect(renderedCodes(html)).toHaveLength(ROWS.length);
  });
});
