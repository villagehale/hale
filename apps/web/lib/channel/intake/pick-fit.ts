import type { ActivityPick } from '~/lib/channel/activity/lane';
import { AGE_TOLERANCE_MONTHS } from '~/lib/registration/match-registration-windows';
import { type RadarChild, parseAgeRange } from './radar-decide';

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
  const band = parseAgeRange(pick.ageFit);
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
