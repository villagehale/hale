/**
 * Growth measurement display + entry conversion — a mobile replica of
 * @hale/types measurement-units (packages/types/src/measurement-units.ts). The
 * native bundle can't import package code (Metro pulls in Node), so the pure
 * conversion helpers are hand-mirrored here, the same rule as the family-stage
 * copy. The measurement-units-parity test is the drift guard.
 *
 * Measurements are ALWAYS stored in metric (kg / cm); the `units` preference is a
 * DISPLAY + ENTRY choice only and never changes storage. There is no temperature
 * and no distance in this product, so this covers exactly weight (kg↔lb) and
 * length (cm↔in).
 */

export type UnitSystem = 'metric' | 'imperial';

export type MeasureKind = 'weight' | 'height' | 'head';

const LB_PER_KG = 2.20462;
const CM_PER_IN = 2.54;

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}

export function cmToIn(cm: number): number {
  return cm / CM_PER_IN;
}

export function inToCm(inches: number): number {
  return inches * CM_PER_IN;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Renders a metric-stored value for display under the chosen unit system. Metric
 * passes the stored value through (kg for weight, cm for length); imperial converts
 * (weight→lb, height/head→in). The value is always rounded to one decimal place.
 */
export function displayMeasurement(
  valueMetric: number,
  kind: MeasureKind,
  units: UnitSystem,
): { value: number; unit: string } {
  if (units === 'metric') {
    return { value: round1(valueMetric), unit: kind === 'weight' ? 'kg' : 'cm' };
  }
  const converted = kind === 'weight' ? kgToLb(valueMetric) : cmToIn(valueMetric);
  return { value: round1(converted), unit: kind === 'weight' ? 'lb' : 'in' };
}

/**
 * Normalizes a value the parent ENTERED (in their chosen unit system) back to the
 * metric value that is stored. Metric entries are already canonical; imperial
 * entries convert (weight→kg, height/head→cm). Used by the measurement-entry path
 * so storage stays metric regardless of the display preference.
 */
export function entryToMetric(valueEntered: number, kind: MeasureKind, units: UnitSystem): number {
  if (units === 'metric') {
    return valueEntered;
  }
  return kind === 'weight' ? lbToKg(valueEntered) : inToCm(valueEntered);
}
