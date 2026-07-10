import { describe, expect, it } from 'vitest';
import { composeMeasurementLog } from './measurement-compose';

/**
 * The load-bearing rule (rule #1): storage is ALWAYS metric, so an imperial entry
 * must be converted to metric BEFORE the POST. These assertions derive the expected
 * metric value from the spec constants (2.20462 lb/kg, 2.54 cm/in), not from the
 * code's output.
 */
describe('composeMeasurementLog', () => {
  const CHILD = 'c1';
  const AT = '2026-07-10T12:00:00.000Z';

  it('converts an imperial weight entry (lb) to metric kg before the POST', () => {
    const out = composeMeasurementLog({
      entry: '22.0462',
      measureKind: 'weight',
      units: 'imperial',
      childId: CHILD,
      occurredAt: AT,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 22.0462 lb ÷ 2.20462 = 10 kg (spec constant), never the entered 22.0462.
    expect(out.body.value).toBeCloseTo(10, 4);
    expect(out.body).toMatchObject({
      kind: 'measurement',
      childId: CHILD,
      measureKind: 'weight',
      occurredAt: AT,
    });
  });

  it('converts an imperial length entry (in) to metric cm before the POST', () => {
    const out = composeMeasurementLog({
      entry: '24.4094',
      measureKind: 'height',
      units: 'imperial',
      childId: CHILD,
      occurredAt: AT,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 24.4094 in × 2.54 = 62 cm (spec constant).
    expect(out.body.value).toBeCloseTo(62, 3);
  });

  it('posts a metric entry unchanged (already canonical)', () => {
    const out = composeMeasurementLog({
      entry: '10.4',
      measureKind: 'weight',
      units: 'metric',
      childId: CHILD,
      occurredAt: AT,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.value).toBe(10.4);
  });

  it('rejects an empty, non-numeric, or non-positive entry (no POST body)', () => {
    for (const entry of ['', '  ', 'abc', '0', '-3']) {
      expect(
        composeMeasurementLog({
          entry,
          measureKind: 'weight',
          units: 'metric',
          childId: CHILD,
          occurredAt: AT,
        }).ok,
        `entry ${JSON.stringify(entry)}`,
      ).toBe(false);
    }
  });
});
