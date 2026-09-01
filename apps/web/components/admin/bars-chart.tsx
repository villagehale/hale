'use client';

import { useReducedMotion } from 'motion/react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fillWindow } from '~/lib/admin/window';
import { AdmChartTooltip } from './chart-tooltip';
import { useWindowDays } from './window-dial';

const NAVY = '#17294a';
const AMBER = '#b26b1f';
const GRID = '#e4e7ee';
const INK3 = '#5c6b87';

export interface DayValue {
  day: string;
  value: number;
}

const usd = (v: number) => `$${v.toFixed(2)}`;
const int = (v: number) => String(Math.round(v));

/**
 * Pure: the sliced window with a running total riding along. The baseline is
 * `total − Σ(all trend rows)` — families older than the trend window are
 * carried honestly, never fabricated — plus every trend row before the
 * window's first day.
 */
export function runningTotals(
  allRows: readonly DayValue[],
  window: readonly DayValue[],
  total: number,
): (DayValue & { cumulative: number })[] {
  const sumAll = allRows.reduce((sum, row) => sum + row.value, 0);
  const firstDay = window[0]?.day ?? '';
  let carry =
    total -
    sumAll +
    allRows.filter((row) => row.day < firstDay).reduce((sum, row) => sum + row.value, 0);
  return window.map((row) => {
    carry += row.value;
    return { ...row, cumulative: carry };
  });
}

/** One-series daily bars (growth, $/day), dial-sliced. Single series → no
 * legend — unless a cumulative stock line rides above the bars. */
export function BarsChart({
  rows,
  name,
  format = 'int',
  height = 180,
  cumulativeTotal,
  cumulativeName = 'total',
}: {
  rows: DayValue[];
  name: string;
  format?: 'int' | 'usd';
  height?: number;
  /** The stock this flow accumulates into (e.g. all families today). When set,
   * a thin line of the running total renders above the bars, on its own axis. */
  cumulativeTotal?: number;
  cumulativeName?: string;
}) {
  const days = useWindowDays();
  const reduced = useReducedMotion();
  const sliced = fillWindow(rows, days, { value: 0 });
  const data =
    cumulativeTotal === undefined ? sliced : runningTotals(rows, sliced, cumulativeTotal);

  return (
    <div style={{ width: '100%', height }}>
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
            allowDecimals={format === 'usd'}
            tickFormatter={(v: number) => (format === 'usd' ? `$${v}` : String(v))}
          />
          {cumulativeTotal !== undefined ? (
            <YAxis
              yAxisId="cumulative"
              orientation="right"
              tick={{ fontSize: 11, fill: INK3 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              width={36}
            />
          ) : null}
          <Tooltip content={<AdmChartTooltip format={format === 'usd' ? usd : int} />} cursor={{ fill: '#fef0c7' }} />
          {cumulativeTotal !== undefined ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
          <Bar
            dataKey="value"
            name={name}
            fill={NAVY}
            radius={[4, 4, 0, 0]}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
          {cumulativeTotal !== undefined ? (
            <Line
              yAxisId="cumulative"
              type="monotone"
              dataKey="cumulative"
              name={cumulativeName}
              stroke={AMBER}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={!reduced}
              animationDuration={300}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
