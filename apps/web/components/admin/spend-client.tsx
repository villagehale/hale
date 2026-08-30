'use client';

import type { AgentSpendData } from '~/lib/admin/queries/agent-spend';
import { lastDays } from '~/lib/admin/window';
import { BarsChart } from './bars-chart';
import { useWindowDays } from './window-dial';

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid];
  const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

/** $/day bars + the window's cache-hit %, run count and latency stat row. */
export function SpendClient({ data }: { data: AgentSpendData }) {
  const windowDays = useWindowDays();
  const inWindow = new Set(lastDays(windowDays));
  const sliced = data.days.filter((d) => inWindow.has(d.day));

  let cost = 0;
  let runs = 0;
  let failed = 0;
  let cacheHits = 0;
  let cacheKnown = 0;
  const p50s: number[] = [];
  for (const d of sliced) {
    cost += d.costUsd;
    runs += d.runs;
    failed += d.failedRuns;
    cacheHits += d.cacheHits;
    cacheKnown += d.cacheKnown;
    if (d.p50LatencyMs !== null) p50s.push(d.p50LatencyMs);
  }
  const hitRate = cacheKnown > 0 ? Math.round((cacheHits / cacheKnown) * 100) : null;
  const p50 = medianOf(p50s);
  const maxAgentRuns = data.byAgent[0]?.runs ?? 1;

  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">${cost.toFixed(2)}</div>
          <div className="adm-stat-k">spend · {windowDays}d</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{runs}</div>
          <div className="adm-stat-k">runs{failed > 0 ? ` · ${failed} failed` : ''}</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{hitRate === null ? '—' : `${hitRate}%`}</div>
          <div className="adm-stat-k">cache hit</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{p50 === null ? '—' : `${Math.round(p50)}ms`}</div>
          <div className="adm-stat-k">p50 (median day)</div>
        </div>
      </div>
      <BarsChart
        rows={data.days.map((d) => ({ day: d.day, value: d.costUsd }))}
        name="$/day"
        format="usd"
        height={150}
      />
      {data.byAgent.length > 0 ? (
        <div className="adm-barlist">
          {data.byAgent.slice(0, 8).map((agent) => (
            <div key={agent.agent} className="adm-barlist-row">
              <span className="adm-barlist-label" title={agent.agent}>
                {agent.agent}
              </span>
              <div className="adm-barlist-track">
                <div
                  className="adm-barlist-fill"
                  style={{ width: `${(agent.runs / maxAgentRuns) * 100}%` }}
                />
              </div>
              <span className="adm-num">{agent.runs}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
