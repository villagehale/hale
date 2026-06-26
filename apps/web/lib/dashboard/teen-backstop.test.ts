import { describe, expect, it } from 'vitest';
import { effectiveTeenContent } from './mappers.js';

/**
 * Rule #1 defense-in-depth on the dashboard surfaces (Approvals + History). The
 * stored events.teen_content flag is a probabilistic classifier signal; a classify
 * miss must NOT leak a 13+ child's raw payload/actionTaken. The query layer resolves
 * the concerns-child's DOB and folds it in here: the EFFECTIVE teen flag the mappers
 * redact on is `storedFlag OR (child is a teen by DOB)`, never the stored flag alone.
 */

const NOW = new Date('2026-06-21T12:00:00Z');
const TEEN_DOB = '2012-01-01'; // ~14y → teenager (boundary 156mo)
const CHILD_DOB = '2019-01-01'; // ~7y → child

describe('effectiveTeenContent', () => {
  it('returns true when the concerns-child is a teen by DOB even if the stored flag is false (the classify miss)', () => {
    expect(effectiveTeenContent(false, TEEN_DOB, NOW)).toBe(true);
  });

  it('returns true when the stored flag is set, regardless of DOB (additive signal)', () => {
    expect(effectiveTeenContent(true, CHILD_DOB, NOW)).toBe(true);
    expect(effectiveTeenContent(true, null, NOW)).toBe(true);
  });

  it('returns false for a non-teen child with no stored flag', () => {
    expect(effectiveTeenContent(false, CHILD_DOB, NOW)).toBe(false);
  });

  it('returns false when there is no resolvable concerns-child and no stored flag', () => {
    expect(effectiveTeenContent(false, null, NOW)).toBe(false);
  });
});
