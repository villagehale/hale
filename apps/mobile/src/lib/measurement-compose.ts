import { entryToMetric, type MeasureKind, type UnitSystem } from './measurement-units';

/**
 * Pure composer for the native Add-measurement sheet: turns the raw entry (in the
 * parent's chosen unit system) into the metric-only wire body the log route
 * expects, or a validation error. Storage is ALWAYS metric (rule #1), so an
 * imperial entry (lb / in) is converted with entryToMetric here, BEFORE the POST —
 * the /api/mobile/companion/log route never sees anything but metric. The server
 * re-validates (measurementSchema + resolveMeasurement bounds); this is the client
 * guard so an empty/unparseable entry never posts.
 */

export interface MeasurementLogBody {
  kind: 'measurement';
  childId: string;
  measureKind: MeasureKind;
  /** The value in METRIC (kg for weight, cm for length), whatever units were entered. */
  value: number;
  occurredAt: string;
}

export function composeMeasurementLog(input: {
  /** The raw text the parent typed, in their chosen unit system. */
  entry: string;
  measureKind: MeasureKind;
  units: UnitSystem;
  childId: string;
  /** ISO instant the reading was taken. */
  occurredAt: string;
}): { ok: true; body: MeasurementLogBody } | { ok: false } {
  const entered = Number(input.entry.trim());
  if (!input.entry.trim() || Number.isNaN(entered) || entered <= 0) {
    return { ok: false };
  }
  const value = entryToMetric(entered, input.measureKind, input.units);
  return {
    ok: true,
    body: {
      kind: 'measurement',
      childId: input.childId,
      measureKind: input.measureKind,
      value,
      occurredAt: input.occurredAt,
    },
  };
}
