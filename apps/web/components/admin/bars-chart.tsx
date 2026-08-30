'use client';

import { useReducedMotion } from 'motion/react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fillWindow } from '~/lib/admin/window';
import { AdmChartTooltip } from './chart-tooltip';
import { useWindowDays } from './window-dial';

const NAVY = '#17294a';
const GRID = '#e4e7ee';
const INK3 = '#5c6b87';

export interface DayValue {
  day: string;
  value: number;
}

const usd = (v: number) => `$${v.toFixed(2)}`;
const int = (v: number) => String(Math.round(v));

/** One-series daily bars (growth, $/day), dial-sliced. Single series → no legend. */
export function BarsChart({
  rows,
  name,
  format = 'int',
  height = 180,
}: {
  rows: DayValue[];
  name: string;
  format?: 'int' | 'usd';
  height?: number;
}) {
  const days = useWindowDays();
  const reduced = useReducedMotion();
  const data = fillWindow(rows, days, { value: 0 });
  const fmt = format === 'usd' ? usd : int;

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
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
          <Tooltip content={<AdmChartTooltip format={fmt} />} cursor={{ fill: '#fef0c7' }} />
          <Bar
            dataKey="value"
            name={name}
            fill={NAVY}
            radius={[4, 4, 0, 0]}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
