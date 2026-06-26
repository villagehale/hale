import { describe, expect, it } from 'vitest';
import { effectiveTeenContent } from './mappers.js';

/**
 * Rule #1 defense-in-depth on the dashboard surfaces (Approvals + History). The
 * stored events.teen_content flag is a probabilistic classifier signal; a classify
 * miss must NOT leak a 13+ child's raw payload/actionTaken. The query layer resolves
 * the concerns-child's DOB (when there is one) and whether the FAMILY has any teen,
 * and folds both in here. The EFFECTIVE teen flag the mappers redact on is
 * `storedFlag OR (child is a teen by DOB) OR (no resolvable child AND family has a
 * teen)` — never the stored flag alone. That last clause is the DOUBLE-MISS guard:
 * teen_content=false AND no attributed child still redacts when the family has a teen
 * (rule #1 "default to most restrictive").
 */

const NOW = new Date('2026-06-21T12:00:00Z');
const TEEN_DOB = '2012-01-01'; // ~14y → teenager (boundary 156mo)
const CHILD_DOB = '2019-01-01'; // ~7y → child

describe('effectiveTeenContent', () => {
  it('returns true when the concerns-child is a teen by DOB even if the stored flag is false (the classify miss)', () => {
    expect(effectiveTeenContent(false, TEEN_DOB, false, NOW)).toBe(true);
  });

  it('returns true when the stored flag is set, regardless of DOB (additive signal)', () => {
    expect(effectiveTeenContent(true, CHILD_DOB, false, NOW)).toBe(true);
    expect(effectiveTeenContent(true, null, false, NOW)).toBe(true);
  });

  it('returns false for a non-teen child with no stored flag, even in a family with a teen sibling', () => {
    expect(effectiveTeenContent(false, CHILD_DOB, true, NOW)).toBe(false);
  });

  // The DOUBLE-MISS: classifier missed the flag AND attributed no child (family-wide
  // / ambiguous). With no DOB to derive, fall back to the family: redact if the
  // family has any teen, surface otherwise (no over-redaction for teen-less families).
  it('returns true on the double-miss when the family has a teen (no stored flag, no resolvable child)', () => {
    expect(effectiveTeenContent(false, null, true, NOW)).toBe(true);
  });

  it('returns false on the double-miss when the family has NO teen', () => {
    expect(effectiveTeenContent(false, null, false, NOW)).toBe(false);
  });
});
