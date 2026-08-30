'use client';

import { useReducedMotion } from 'motion/react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TextingDay } from '~/lib/admin/queries/texting';
import { fillWindow } from '~/lib/admin/window';
import { AdmChartTooltip } from './chart-tooltip';
import { useWindowDays } from './window-dial';

const NAVY = '#17294a';
const AMBER = '#b26b1f';
const GRID = '#e4e7ee';
const INK3 = '#5c6b87';

function tickLabel(day: string): string {
  return day.slice(5); // MM-DD
}

/** The texting trend: daily senders (navy area) + msgs in/out (amber lines). */
export function TrendChart({ rows }: { rows: TextingDay[] }) {
  const days = useWindowDays();
  const reduced = useReducedMotion();
  const data = fillWindow(rows, days, { senders: 0, msgsIn: 0, msgsOut: 0 });

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={tickLabel}
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
          />
          <Tooltip content={<AdmChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area
            type="monotone"
            dataKey="senders"
            name="senders"
            stroke={NAVY}
            strokeWidth={2}
            fill={NAVY}
            fillOpacity={0.2}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
          <Line
            type="monotone"
            dataKey="msgsIn"
            name="msgs in"
            stroke={AMBER}
            strokeWidth={2}
            dot={false}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
          <Line
            type="monotone"
            dataKey="msgsOut"
            name="msgs out"
            stroke={AMBER}
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={!reduced}
            animationDuration={300}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
