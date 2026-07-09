import { stageFromAgeInMonths as canonical } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { stageFromAgeInMonths as mobile } from './family-stage';

/**
 * Mobile deliberately carries no runtime @hale/types dependency (Metro
 * isolation), so its stage mapping is a hand-mirror of the canonical one. This
 * parity sweep is the drift guard: every boundary-adjacent age must map
 * identically, or a boundary change in @hale/types ships without the mobile
 * mirror and the two surfaces disagree about who is a teenager (rule #1's gate).
 */
describe('family-stage parity with @hale/types', () => {
  it('maps every boundary-adjacent age identically to the canonical mapping', () => {
    const ages = [0, 1, 11, 12, 13, 47, 48, 49, 155, 156, 157, 215];
    for (const months of ages) {
      expect(mobile(months), `age ${months}mo`).toBe(canonical(months));
    }
  });
});
