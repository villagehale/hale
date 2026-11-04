import type { ActivityPick } from '~/lib/channel/activity/lane';
import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';
import { type AgeBand, type RadarChild, parseAgeRange } from './radar-decide';

const GRADE_LABEL = /\b(grades?|kindergarten)\b/i;
const NUMBER = /\d+(?:\.\d+)?/g;

/**
 * The band a label reads as, or null when parseAgeRange's single-unit read would misstate
 * it: a school grade is not an age in years, and a label with more numbers than the band
 * used ("2-5 years (under 18 months free)") holds a second age statement whose unit the
 * parser applies to the whole label.
 */
function readableBand(ageFit: string | null): AgeBand | null {
  const band = parseAgeRange(ageFit);
  if (!band || !ageFit || GRADE_LABEL.test(ageFit)) return null;
  const used = Number(band.minMonths !== null) + Number(band.maxMonths !== null);
  return [...ageFit.matchAll(NUMBER)].length > used ? null : band;
}

/**
 * Whether a found pick is for at least one of these children, read against their ages
 * in months, never their stages. A label we cannot read, an all-ages label, and a band
 * whose bounds read inverted are kept: there is no fact to leave them out on. A derived
 * DOB widens the band by the registration matcher's tolerance.
 */
export function fitsHouseholdAges(
  pick: Pick<ActivityPick, 'ageFit'>,
  children: readonly Pick<RadarChild, 'ageMonths' | 'dobPrecision'>[],
): boolean {
  const band = readableBand(pick.ageFit);
  if (!band) return true;
  const { minMonths, maxMonths } = band;
  if (minMonths === null && maxMonths === null) return true;
  if (minMonths !== null && maxMonths !== null && minMonths > maxMonths) return true;
  return children.some((child) => {
    if (child.ageMonths === null) return false;
    const slack = child.dobPrecision === 'derived' ? AGE_TOLERANCE_MONTHS : 0;
    if (minMonths !== null && child.ageMonths < minMonths - slack) return false;
    if (maxMonths !== null && child.ageMonths > maxMonths + slack) return false;
    return true;
  });
}
