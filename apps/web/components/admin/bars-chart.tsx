'use client';

import { useReducedMotion } from 'motion/react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fillWindow } from '~/lib/admin/window';
import { useAdminChartTheme } from './chart-theme';
import { AdmChartTooltip } from './chart-tooltip';
import { useWindowDays } from './window-dial';

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
  const theme = useAdminChartTheme();
  const sliced = fillWindow(rows, days, { value: 0 });
  const data =
    cumulativeTotal === undefined ? sliced : runningTotals(rows, sliced, cumulativeTotal);

  // Editorial: two series never earn a legend — the cumulative line is named
  // directly at its end, in ink-2 (AA on the panel in both themes), hugging
  // the line the way a margin note hugs its sentence.
  const lastIndex = data.length - 1;
  const endLabel = (props: { x?: number | string; y?: number | string; index?: number }) =>
    props.index === lastIndex && typeof props.x === 'number' && typeof props.y === 'number' ? (
      <text x={props.x} y={props.y - 8} textAnchor="end" fontSize={11} fill={theme.label}>
        {cumulativeName}
      </text>
    ) : null;

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        {/* Extra headroom when the end-of-line label rides above the cumulative
         * line's last (and highest) point, so it never clips at the top edge. */}
        <ComposedChart
          data={data}
          margin={{ top: cumulativeTotal === undefined ? 4 : 18, right: 4, left: -18, bottom: 0 }}
        >
          <CartesianGrid stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={(d: string) => d.slice(5)}
            tick={{ fontSize: 11, fill: theme.tick }}
            tickLine={false}
            axisLine={{ stroke: theme.axis }}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.tick }}
            tickLine={false}
            axisLine={false}
            allowDecimals={format === 'usd'}
            tickFormatter={(v: number) => (format === 'usd' ? `$${v}` : String(v))}
          />
          {cumulativeTotal !== undefined ? (
            <YAxis
              yAxisId="cumulative"
              orientation="right"
              tick={{ fontSize: 11, fill: theme.tick }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              width={36}
            />
          ) : null}
          <Tooltip content={<AdmChartTooltip format={format === 'usd' ? usd : int} />} cursor={{ fill: theme.cursor }} />
          <Bar
            dataKey="value"
            name={name}
            fill={theme.ink}
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
              stroke={theme.amber}
              strokeWidth={1.5}
              dot={false}
              label={endLabel}
              isAnimationActive={!reduced}
              animationDuration={300}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
