import {
  displayMeasurement as canonicalDisplay,
  entryToMetric as canonicalEntry,
} from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  displayMeasurement as mobileDisplay,
  entryToMetric as mobileEntry,
} from './measurement-units';

/**
 * Mobile deliberately carries no runtime @hale/types dependency (Metro
 * isolation), so its measurement conversion is a hand-mirror of the canonical
 * one. This parity sweep is the drift guard: every kind × unit-system must convert
 * identically, or a constant/rounding change in @hale/types ships without the
 * mobile mirror and the two surfaces disagree about a newborn's weight (rule #1).
 */
describe('measurement-units parity with @hale/types', () => {
  const kinds = ['weight', 'height', 'head'] as const;
  const systems = ['metric', 'imperial'] as const;
  const values = [0, 3.4, 10.4, 62, 155.5];

  it('displays every kind × unit-system identically to the canonical mapping', () => {
    for (const kind of kinds) {
      for (const units of systems) {
        for (const v of values) {
          expect(mobileDisplay(v, kind, units), `${kind}/${units}/${v}`).toEqual(
            canonicalDisplay(v, kind, units),
          );
        }
      }
    }
  });

  it('normalizes every entered value back to metric identically to the canonical mapping', () => {
    for (const kind of kinds) {
      for (const units of systems) {
        for (const v of values) {
          expect(mobileEntry(v, kind, units), `${kind}/${units}/${v}`).toBe(
            canonicalEntry(v, kind, units),
          );
        }
      }
    }
  });
});
