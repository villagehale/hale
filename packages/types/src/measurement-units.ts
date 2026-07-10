/**
 * The single source of truth for how a growth measurement is DISPLAYED and how an
 * entered value is normalized back to storage. Measurements are ALWAYS stored in
 * metric (kg for weight, cm for height/head) — rule #1: newborn data, one canonical
 * unit so a series never mixes units. The `units` preference is a DISPLAY choice
 * only; it never changes what is stored. There is no temperature and no distance in
 * this product, so this module covers exactly weight (kg↔lb) and length (cm↔in).
 *
 * Both apps import these pure helpers so a conversion constant or rounding rule is
 * never duplicated (or drifting) across web display and mobile entry.
 */

export type UnitSystem = 'metric' | 'imperial';

/** The growth measurement kinds — mirrors MEASURE_KINDS in the web log-types module;
 * this is the shared type both surfaces convert against. */
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

/** Round to a single decimal place — the display precision for every measurement. */
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
 * entries convert (weight→kg, height/head→cm). Used by the mobile measurement-entry
 * path so storage stays metric regardless of the display preference.
 */
export function entryToMetric(valueEntered: number, kind: MeasureKind, units: UnitSystem): number {
  if (units === 'metric') {
    return valueEntered;
  }
  return kind === 'weight' ? lbToKg(valueEntered) : inToCm(valueEntered);
}
