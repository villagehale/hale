'use client';

import type { AgentDay } from '~/lib/admin/queries/agent-spend';
import { lastDays } from '~/lib/admin/window';
import { DataTable } from './data-table';
import { useWindowDays } from './window-dial';

/**
 * The fleet leaderboard: agent, runs (with the in-cell share bar), failed and
 * $ cost — dial-sliced from day-grain rows, sortable and filterable. Per-agent
 * p50 is deliberately absent: daily p50s can't be recomposed per-agent
 * client-side without lying; the fleet stat row carries latency.
 */
export interface AgentRank {
  agent: string;
  runs: number;
  failed: number;
  cost: string;
}

/** Pure: dial-slice, sum per agent, rank by runs. */
export function rankAgents(rows: readonly AgentDay[], days: number): AgentRank[] {
  const inWindow = new Set(lastDays(days));
  const byAgent = new Map<string, { runs: number; failed: number; costUsd: number }>();
  for (const row of rows) {
    if (!inWindow.has(row.day)) continue;
    const entry = byAgent.get(row.agent) ?? { runs: 0, failed: 0, costUsd: 0 };
    entry.runs += row.runs;
    entry.failed += row.failedRuns;
    entry.costUsd += row.costUsd;
    byAgent.set(row.agent, entry);
  }
  return [...byAgent.entries()]
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([agent, sums]) => ({
      agent,
      runs: sums.runs,
      failed: sums.failed,
      cost: `$${sums.costUsd.toFixed(2)}`,
    }));
}

export function AgentLeaderboard({ rows }: { rows: AgentDay[] }) {
  const days = useWindowDays();
  const ranked = rankAgents(rows, days);
  if (ranked.length === 0) {
    return <p className="adm-state">No runs in this window.</p>;
  }
  return (
    <DataTable
      rows={ranked.map((row) => ({ ...row }))}
      columns={[
        { key: 'agent', label: 'agent', mono: true },
        { key: 'runs', label: 'runs', bar: true },
        { key: 'failed', label: 'failed' },
        { key: 'cost', label: '$ cost' },
      ]}
      initialSort={{ key: 'runs', desc: true }}
      filterPlaceholder="filter agents…"
    />
  );
}
