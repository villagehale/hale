'use client';

import type { IntakeSourceDay } from '~/lib/admin/queries/intake-funnel';
import { lastDays } from '~/lib/admin/window';
import { DataTable } from './data-table';
import { useWindowDays } from './window-dial';

/**
 * Which poster works: the QR venue codes as a sortable/filterable table —
 * source, started (with an in-cell share bar), family, conversion % — summed
 * from day-grain rows over the dial window. Ranking/limiting is a display
 * concern here, not the SQL's.
 */
export interface RankedSource {
  source: string;
  started: number;
  family: number;
  conversion: string;
}

/** Pure: dial-slice, sum per code, rank by starts. */
export function rankSources(rows: readonly IntakeSourceDay[], days: number): RankedSource[] {
  const inWindow = new Set(lastDays(days));
  const byCode = new Map<string, { started: number; provisioned: number }>();
  for (const row of rows) {
    if (!inWindow.has(row.day)) continue;
    const entry = byCode.get(row.code) ?? { started: 0, provisioned: 0 };
    entry.started += row.started;
    entry.provisioned += row.provisioned;
    byCode.set(row.code, entry);
  }
  return [...byCode.entries()]
    .sort((a, b) => b[1].started - a[1].started)
    .map(([source, sums]) => ({
      source,
      started: sums.started,
      family: sums.provisioned,
      conversion:
        sums.started > 0 ? `${Math.round((sums.provisioned / sums.started) * 100)}%` : '—',
    }));
}

export function IntakeSourcesTable({ sources }: { sources: IntakeSourceDay[] }) {
  const days = useWindowDays();
  const ranked = rankSources(sources, days);
  if (ranked.length === 0) {
    return <p className="adm-state">No sources in this window — direct texts only.</p>;
  }
  return (
    <DataTable
      rows={ranked.map((row) => ({ ...row }))}
      columns={[
        { key: 'source', label: 'source', mono: true },
        { key: 'started', label: 'started', bar: true },
        { key: 'family', label: 'family' },
        { key: 'conversion', label: 'conv %' },
      ]}
      initialSort={{ key: 'started', desc: true }}
      filterPlaceholder="filter sources…"
    />
  );
}
