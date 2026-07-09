import {
  MEASURE_KINDS,
  MEASURE_META,
  MEASUREMENT_EPISODE,
  type MeasureKind,
} from './log-types.js';
import type { LogView } from './logs-view.js';

/** One reading in a growth series: the value, its server-fixed unit, and when it
 * was taken. Derived only from the ENUM-GATED numerics the shared logs read lifts,
 * never from a raw payload, so a redacted/foreign row can't contribute (rule #1). */
export interface Measurement {
  id: string;
  value: number;
  unit: string;
  occurredAt: string;
}

/** A per-kind growth series: the kind, its readings newest→oldest, the unit (from
 * the readings), and the peak value for scaling a mini-trend bar. Empty `readings`
 * means the kind has nothing logged yet. */
export interface MeasureSeries {
  kind: MeasureKind;
  label: string;
  unit: string | null;
  readings: Measurement[];
  peak: number;
}

function isMeasureKind(v: string | undefined): v is MeasureKind {
  return v !== undefined && (MEASURE_KINDS as readonly string[]).includes(v);
}

/**
 * Buckets the family's logged measurements (from the shared, teen-redacted logs
 * read) into one series per measure kind, newest first. Pure — no I/O. Only rows
 * that are a measurement episode AND carry the lifted measureKind + numeric value +
 * unit contribute; anything else (a feed, a nap, a redacted row that never reached
 * this shape) is ignored rather than charted as zero. The unit is taken from the
 * readings (the server fixes it per kind), so a series never invents one.
 */
export function buildMeasureSeries(logs: LogView[]): MeasureSeries[] {
  const byKind = new Map<MeasureKind, Measurement[]>();
  for (const kind of MEASURE_KINDS) byKind.set(kind, []);

  for (const log of logs) {
    if (log.episodeType !== MEASUREMENT_EPISODE) continue;
    if (!isMeasureKind(log.measureKind)) continue;
    if (typeof log.value !== 'number' || typeof log.unit !== 'string') continue;
    byKind.get(log.measureKind)?.push({
      id: log.id,
      value: log.value,
      unit: log.unit,
      occurredAt: log.occurredAt,
    });
  }

  return MEASURE_KINDS.map((kind) => {
    const readings = byKind.get(kind) ?? [];
    const peak = readings.reduce((max, r) => Math.max(max, r.value), 0);
    return {
      kind,
      label: MEASURE_META[kind].label,
      unit: readings[0]?.unit ?? null,
      readings,
      peak,
    };
  });
}
