/**
 * The aggregate social-proof copy for a candidate's endorsements (rule #1: a
 * COUNT only, never a family identity). Pure so it renders identically on the
 * private village card and inside the public share artifacts, and is unit-tested.
 *
 * Returns null below the threshold: one endorsement is not yet "loved by
 * families near you", and showing "loved by 1 family" reads thin and risks
 * de-anonymizing in a small area. Social proof appears at 2+.
 */
const SOCIAL_PROOF_MIN = 2;

export function endorsementLabel(count: number): string | null {
  if (count < SOCIAL_PROOF_MIN) {
    return null;
  }
  return `loved by ${count} families near you`;
}
