import { useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { AppText } from '@/components/ui/app-text';
import { useMeadowColor } from '@/constants/meadow';
import type { Measurement, MeasureKind } from '@/lib/measurement-series';
import { displayMeasurement, type UnitSystem } from '@/lib/measurement-units';

const CHART_H = 130;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 112;
const INSET_X = 12;

/** "May 12" — the compact month+day the value tag and axis use. */
function monthDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The distinct calendar months the readings span (oldest→newest), for the x-axis.
 * Each carries a position-stable key so repeated month names (a record spanning a
 * year) stay unique without keying on the render index. */
function monthLabels(readingsOldestFirst: Measurement[]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (const r of readingsOldestFirst) {
    const label = new Date(r.occurredAt).toLocaleDateString(undefined, { month: 'short' });
    if (out[out.length - 1]?.label !== label) out.push({ key: `${label}-${out.length}`, label });
  }
  return out;
}

/**
 * The real growth line chart (Growth tab) — react-native-svg, RN-web-safe. Plots the
 * selected measure's ACTUAL readings (oldest→newest, left→right); the y-axis scales
 * to the readings' own min/max, the x-axis is spaced evenly by reading and labelled
 * with the real months spanned. No percentile curves / WHO overlay — a plain trend of
 * what was logged. Readings arrive newest-first (buildMeasureSeries) and are reversed
 * here. Values are stored metric; the value tag converts per the viewer's Units.
 */
export function GrowthChart({
  readings,
  kind,
  units,
}: {
  readings: Measurement[];
  kind: MeasureKind;
  units: UnitSystem;
}) {
  const [width, setWidth] = useState(0);
  const line = useMeadowColor('chipBlueIcon');
  const grid = useMeadowColor('ink3');

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const ordered = [...readings].reverse(); // oldest → newest
  const values = ordered.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const x = (i: number) =>
    ordered.length <= 1
      ? width / 2
      : INSET_X + (i * (width - INSET_X * 2)) / (ordered.length - 1);
  const y = (v: number) =>
    span === 0 ? (PLOT_TOP + PLOT_BOTTOM) / 2 : PLOT_BOTTOM - ((v - min) / span) * (PLOT_BOTTOM - PLOT_TOP);

  const points = ordered.map((r, i) => `${x(i)},${y(r.value)}`).join(' ');
  const latest = readings[0];
  const latestDisplay = displayMeasurement(latest.value, kind, units);
  const months = monthLabels(ordered);

  return (
    <View className="gap-2">
      <View className="relative" style={{ height: CHART_H }} onLayout={onLayout}>
        {width > 0 ? (
          <Svg width={width} height={CHART_H}>
            {[0.25, 0.5, 0.75].map((f) => {
              const gy = PLOT_TOP + f * (PLOT_BOTTOM - PLOT_TOP);
              return (
                <Line
                  key={f}
                  x1={0}
                  y1={gy}
                  x2={width}
                  y2={gy}
                  stroke={grid}
                  strokeWidth={1}
                  opacity={0.18}
                />
              );
            })}
            {ordered.length >= 2 ? (
              <Polyline points={points} fill="none" stroke={line} strokeWidth={2} />
            ) : null}
            {ordered.map((r, i) => {
              const isLast = i === ordered.length - 1;
              return (
                <Circle
                  key={r.id}
                  cx={x(i)}
                  cy={y(r.value)}
                  r={isLast ? 4 : 3}
                  fill={isLast ? '#ffffff' : line}
                  stroke={line}
                  strokeWidth={isLast ? 2.4 : 0}
                />
              );
            })}
          </Svg>
        ) : null}
        <View className="absolute right-0 top-1.5 items-center rounded-lg bg-ink px-2 py-1">
          <AppText className="text-[11px] leading-[14px] text-on-ink" style={{ fontFamily: 'InstrumentSans_700Bold' }}>
            {latestDisplay.value} {latestDisplay.unit}
          </AppText>
          <AppText variant="meta" className="text-[10px] leading-[13px] text-on-ink opacity-70">
            {monthDay(latest.occurredAt)}
          </AppText>
        </View>
      </View>
      {months.length > 0 ? (
        <View className="flex-row justify-between">
          {months.map((m) => (
            <AppText key={m.key} variant="meta" className="text-[10.5px] text-ink-3">
              {m.label}
            </AppText>
          ))}
        </View>
      ) : null}
    </View>
  );
}
