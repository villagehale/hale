import { ageInMonths } from '@hale/types';
import { assessGrowth } from './growth-standards.js';
import { buildMeasureSeries, type Measurement } from './growth-series.js';
import type { GrowthBand, LogView } from './logs-view.js';
import { MEASURE_META, type MeasureKind } from './log-types.js';

/**
 * The child-hub header's growth stats (design handoff §4.3): each measure's LATEST
 * reading plus its REAL WHO read. The percentile is the standard-normal CDF of the
 * WHO z-score — a deterministic transform of the committed LMS math, never a
 * fabricated number — so "42nd %ile" is the child's actual WHO percentile, not a
 * placeholder. A percentile is present ONLY for an 'assessed' reading; the honest
 * absences (no usable sex, preterm, outside WHO's 0–5y) carry the state instead.
 */
export interface GrowthHeaderStat {
  kind: MeasureKind;
  /** "Weight" / "Height" / "Head". */
  label: string;
  /** The latest reading, in STORED metric (kg/cm); the view converts per units. */
  valueMetric: number;
  unit: string;
  occurredAt: string;
  assessment:
    | { state: 'assessed'; z: number; band: GrowthBand; percentile: number }
    | { state: 'needs-details' | 'preterm' | 'out-of-range' };
}

/**
 * Standard-normal CDF Φ(z) as a percentile in [1, 99] (growth-chart convention:
 * the tails read as 1st / 99th, never 0 / 100). Zelen & Severo (Abramowitz &
 * Stegun 26.2.17) rational approximation — |error| < 7.5e-8, ample for a whole
 * percentile. Pure.
 */
export function zToPercentile(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = d * poly; // P(Z > |z|)
  const cdf = z >= 0 ? 1 - upper : upper;
  const pct = Math.round(cdf * 100);
  return Math.min(99, Math.max(1, pct));
}

/** The newest reading in a series by occurredAt (ISO strings sort chronologically);
 * null for an empty series. Order-independent, so it doesn't rely on the input's
 * sort. */
function newestReading(readings: Measurement[]): Measurement | null {
  let latest: Measurement | null = null;
  for (const r of readings) {
    if (!latest || r.occurredAt > latest.occurredAt) latest = r;
  }
  return latest;
}

/**
 * Build the header stats for ONE child from its (already teen-redacted) measurement
 * logs and its own dob/sex/gestation. One stat per measure kind that has a reading;
 * a kind with nothing logged is simply omitted (the header shows a "log a
 * measurement" affordance for it). Composes the existing pure pieces
 * (buildMeasureSeries for the latest reading, assessGrowth for the WHO read), so the
 * WHO LMS tables stay on the server. Age is the child's age AT the reading's date —
 * a measurement is judged against the age it was taken.
 */
export function buildGrowthHeader(
  logs: LogView[],
  child: { dateOfBirth: string; biologicalSex: string | null; gestationalWeeks: number | null },
): GrowthHeaderStat[] {
  const out: GrowthHeaderStat[] = [];
  for (const series of buildMeasureSeries(logs)) {
    const latest = newestReading(series.readings);
    if (!latest) continue;
    const read = assessGrowth({
      measureKind: series.kind,
      valueMetric: latest.value,
      ageMonths: ageInMonths(child.dateOfBirth, new Date(latest.occurredAt)),
      biologicalSex: child.biologicalSex,
      gestationalWeeks: child.gestationalWeeks,
    });
    const assessment =
      read.state === 'assessed'
        ? {
            state: 'assessed' as const,
            z: read.z,
            band: read.band,
            percentile: zToPercentile(read.z),
          }
        : { state: read.state };
    out.push({
      kind: series.kind,
      label: MEASURE_META[series.kind].label,
      valueMetric: latest.value,
      unit: latest.unit,
      occurredAt: latest.occurredAt,
      assessment,
    });
  }
  return out;
}
