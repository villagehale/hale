import { townLabel } from '~/lib/channel/town-label';
import type { TorontoDistrict } from '~/lib/registration/fsa-municipalities';
import {
  resolveDistrict,
  resolveMunicipalities,
} from '~/lib/registration/match-registration-windows';

/**
 * What a web search may call "near". A Toronto postal code is one district, not
 * the whole city: Danforth and Pape (M4K) is Toronto and East York, and a
 * Scarborough branch is not near it. Outside Toronto this is the municipality,
 * the same string {@link townLabel} already uses. Never a postal code.
 */
const DISTRICT_TOWN: Record<TorontoDistrict, string> = {
  toronto_east_york: 'Toronto and East York',
  scarborough: 'Scarborough',
  north_york: 'North York',
  etobicoke_york: 'Etobicoke and York',
};

export function activitySearchTown(areaCoarse: string | null | undefined): string | null {
  if (!areaCoarse) return null;
  const district = resolveDistrict(areaCoarse);
  if (district) return DISTRICT_TOWN[district];
  const municipalities = resolveMunicipalities(areaCoarse);
  if (municipalities.length !== 1) return null;
  const only = municipalities[0];
  return only ? townLabel(only) : null;
}
