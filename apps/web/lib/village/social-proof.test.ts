import { describe, expect, it } from 'vitest';
import { endorsementLabel } from './social-proof.js';

describe('endorsementLabel — aggregate social proof (rule #1)', () => {
  it('returns null for 0 and 1 — below the threshold, no thin "loved by 1 family"', () => {
    expect(endorsementLabel(0)).toBeNull();
    expect(endorsementLabel(1)).toBeNull();
  });

  it('returns an aggregate count label at the 2+ threshold — a count, never a family name', () => {
    expect(endorsementLabel(2)).toBe('loved by 2 families near you');
    expect(endorsementLabel(17)).toBe('loved by 17 families near you');
  });
});
