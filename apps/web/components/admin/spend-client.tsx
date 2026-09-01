'use client';

import { useReducedMotion } from 'motion/react';
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AgentSpendData } from '~/lib/admin/queries/agent-spend';
import { fillWindow, lastDays } from '~/lib/admin/window';
import { BarsChart } from './bars-chart';
import { AdmChartTooltip } from './chart-tooltip';
import { useWindowDays } from './window-dial';

const AMBER = '#b26b1f';
const NAVY = '#17294a';
const GRID = '#e4e7ee';
const INK3 = '#5c6b87';

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const a = sorted[mid];
  const b = sorted[sorted.length % 2 === 0 ? mid - 1 : mid];
  return a === undefined || b === undefined ? null : (a + b) / 2;
}

/** A small fleet-trend line: no-run days are GAPS (connectNulls off), never zeros. */
function FleetLine({
  data,
  dataKey,
  name,
  stroke,
  format,
}: {
  data: { day: string; [key: string]: string | number | null }[];
  dataKey: string;
  name: string;
  stroke: string;
  format: (v: number) => string;
}) {
  const reduced = useReducedMotion();
  return (
    <div style={{ width: '100%', height: 120 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) => d.slice(5)}
            tick={{ fontSize: 11, fill: INK3 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 11, fill: INK3 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => format(v)}
          />
          <Tooltip content={<AdmChartTooltip format={format} />} />
          <Line
            type="monotone"
            dataKey={dataKey}
            name={name}
            stroke={stroke}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** $/day bars + the window's cache-hit %, run count and latency stat row, plus
 * the two fleet trends (p50 latency, cache-hit rate) that were loaded but
 * never charted. Per-agent runs live in the leaderboard table now. */
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

  const trendData = fillWindow(data.days, windowDays, {
    costUsd: 0,
    runs: 0,
    failedRuns: 0,
    cacheHits: 0,
    cacheKnown: 0,
    p50LatencyMs: null,
  }).map((d) => ({
    day: d.day,
    p50LatencyMs: d.runs > 0 ? d.p50LatencyMs : null,
    hitRate: d.cacheKnown > 0 ? Math.round((d.cacheHits / d.cacheKnown) * 100) : null,
  }));

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
      <FleetLine
        data={trendData}
        dataKey="p50LatencyMs"
        name="p50 latency"
        stroke={NAVY}
        format={(v) => `${Math.round(v)}ms`}
      />
      <FleetLine
        data={trendData}
        dataKey="hitRate"
        name="cache-hit rate"
        stroke={AMBER}
        format={(v) => `${v}%`}
      />
    </div>
  );
}
