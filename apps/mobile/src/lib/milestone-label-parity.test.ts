import { milestoneStatusLabel as canonical } from '@hale/types';
import { describe, expect, it } from 'vitest';
import type { MilestoneStatus } from './api-types';
import { milestoneStatusLabel as mobile } from './format';

/**
 * VIL-260 · WS5. Mobile carries no runtime @hale/types dependency (Metro
 * isolation), so its milestone labelling is a hand-mirror — and a hand-mirror of
 * a UNION is the silent-drop landmine: add a timing to @hale/types and the mobile
 * map renders `undefined` under a milestone, with nothing failing anywhere.
 *
 * The `satisfies` below is the compile half (a value the local union has lost
 * stops type-checking) and the sweep is the runtime half (a value the canonical
 * union has GAINED has no mobile label, so the two disagree).
 */
const TIMINGS = [
  'upcoming',
  'in_window',
  'watch',
  'passed',
] as const satisfies readonly MilestoneStatus['timing'][];

describe('milestone label parity with @hale/types', () => {
  it('labels every timing, done and not-done, exactly as the canonical does', () => {
    for (const timing of TIMINGS) {
      for (const done of [false, true]) {
        expect(mobile({ timing, done }), `${timing} done=${done}`).toBe(canonical({ timing, done }));
      }
    }
  });

  it('never renders an empty or undefined label', () => {
    for (const timing of TIMINGS) {
      expect(mobile({ timing, done: false })).toMatch(/\S/);
    }
  });
});
