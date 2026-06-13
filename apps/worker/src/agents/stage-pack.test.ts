import { describe, it, expect } from 'vitest';
import type { FamilyStage } from '@haru/types';
import { stagePackFor, type StagePackText } from './stage-pack.js';

// Distinct sentinel text per stage so ordering/dedup is observable without
// depending on the real pack copy.
const PACKS: StagePackText = {
  newborn: 'NEWBORN-PACK',
  toddler: 'TODDLER-PACK',
  child: 'CHILD-PACK',
  teenager: 'TEEN-PACK',
};

describe('stagePackFor', () => {
  it('returns empty string for no stages so callers can append unconditionally', () => {
    expect(stagePackFor([], PACKS)).toBe('');
  });

  it('renders a single stage under the shared header', () => {
    expect(stagePackFor(['toddler'], PACKS)).toBe('## Stage-aware context\n\nTODDLER-PACK');
  });

  it('orders multiple stages by childhood progression regardless of input order', () => {
    const out = stagePackFor(['teenager', 'newborn'], PACKS);
    expect(out).toBe('## Stage-aware context\n\nNEWBORN-PACK\n\n---\n\nTEEN-PACK');
  });

  it('dedupes repeated stages (multi-child families with two kids in one stage)', () => {
    const stages: FamilyStage[] = ['toddler', 'toddler', 'newborn', 'newborn'];
    expect(stagePackFor(stages, PACKS)).toBe(
      '## Stage-aware context\n\nNEWBORN-PACK\n\n---\n\nTODDLER-PACK',
    );
  });

  it('throws when packs are neither injected nor loaded', () => {
    expect(() => stagePackFor(['newborn'])).toThrow(/packs not loaded/);
  });
});
