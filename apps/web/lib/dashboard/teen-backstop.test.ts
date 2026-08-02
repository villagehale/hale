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
    expect(effectiveTeenContent(false, TEEN_DOB, false, 'child_content', NOW)).toBe(true);
  });

  it('returns true when the stored flag is set, regardless of DOB (additive signal)', () => {
    expect(effectiveTeenContent(true, CHILD_DOB, false, 'child_content', NOW)).toBe(true);
    expect(effectiveTeenContent(true, null, false, 'child_content', NOW)).toBe(true);
  });

  it('returns false for a non-teen child with no stored flag, even in a family with a teen sibling', () => {
    expect(effectiveTeenContent(false, CHILD_DOB, true, 'child_content', NOW)).toBe(false);
  });

  // The DOUBLE-MISS: classifier missed the flag AND attributed no child (family-wide
  // / ambiguous). With no DOB to derive, fall back to the family: redact if the
  // family has any teen, surface otherwise (no over-redaction for teen-less families).
  it('returns true on the double-miss when the family has a teen (no stored flag, no resolvable child)', () => {
    expect(effectiveTeenContent(false, null, true, 'child_content', NOW)).toBe(true);
  });

  it('returns false on the double-miss when the family has NO teen', () => {
    expect(effectiveTeenContent(false, null, false, 'child_content', NOW)).toBe(false);
  });
});

/**
 * VIL-260 · WS3b — PROVENANCE gates the double-miss fallback, and nothing above it.
 *
 * The fallback protects unattributed content that came from OUTSIDE Hale. A draft Hale
 * composed from public reference data (a municipal registration window) has no
 * child-authored content in it, so there is nothing for the fallback to protect — and
 * because it names no child, no grant could ever unlock it, which left a toddler
 * family with a teen sibling permanently unable to approve it.
 */
describe('effectiveTeenContent × content provenance', () => {
  it('does NOT apply the family fallback to a draft Hale authored from reference data', () => {
    expect(effectiveTeenContent(false, null, true, 'hale_authored', NOW)).toBe(false);
  });

  it('still applies it to unattributed content that came from outside', () => {
    expect(effectiveTeenContent(false, null, true, 'child_content', NOW)).toBe(true);
  });

  it('fails closed when no provenance is declared at all', () => {
    // A row written before the column existed, or a mint site that never declared —
    // the default is the private answer.
    expect(effectiveTeenContent(false, null, true)).toBe(true);
  });

  it('never lets provenance override the age gate — a named 13+ child still redacts', () => {
    // The one thing provenance must NOT do: a Hale-authored draft that names a
    // teenager is still that teenager's row.
    expect(effectiveTeenContent(false, TEEN_DOB, false, 'hale_authored', NOW)).toBe(true);
  });

  it('never lets provenance override the classifier flag', () => {
    expect(effectiveTeenContent(true, null, false, 'hale_authored', NOW)).toBe(true);
  });
});
