import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { townLabel } from '~/lib/channel/town-label';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import type { FamilyPlace } from './answer';

/**
 * Where a family is, as the off-topic search may be told it: a city and a country, or a
 * named reason there is none (founder, 2026-10-12; see answer.ts).
 *
 * THE FAMILY'S OWN ROW IS THE ONLY SOURCE. Its stored city and country when both are
 * there. A family that arrived by text has a country and a postal code and no city
 * (intake never asks for one), so for them the city is the town their postal area belongs
 * to, read through the registration radar's map and spelled by town-label. Nothing here
 * guesses: a postal area outside the towns that map covers is `unmapped`, one that spans
 * two towns is `ambiguous`, and a country that is not on the row is never inferred, not
 * even from a postal code only one country could have.
 *
 * `area_coarse` is not reliably a postal area: for a family with no postal code it holds
 * a city or a neighbourhood name. It is read only through the map, which refuses anything
 * that is not postal-area shaped, so a neighbourhood can never come back out as a city.
 *
 * The postal code, the area and the province never leave this function. It returns two
 * names or a reason.
 */

function stored(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function placeOf(family: {
  country: string | null;
  city: string | null;
  postalCode: string | null;
  areaCoarse: string | null;
}): FamilyPlace {
  const country = stored(family.country);
  if (country === null) return { status: 'unknown', reason: 'no_country' };
  const city = stored(family.city);
  if (city !== null) return { status: 'known', city, country };

  const postal = stored(family.postalCode) ?? stored(family.areaCoarse);
  if (postal === null) return { status: 'unknown', reason: 'no_postal' };
  const [town, ...others] = resolveMunicipalities(postal);
  if (town === undefined) return { status: 'unknown', reason: 'unmapped' };
  if (others.length > 0) return { status: 'unknown', reason: 'ambiguous' };
  return { status: 'known', city: townLabel(town), country };
}

/** Reads the four columns {@link placeOf} needs and no other. */
export async function readFamilyPlace(database: Database, familyId: string): Promise<FamilyPlace> {
  const [family] = await database
    .select({
      country: schema.families.country,
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) throw new Error('off-domain place: no family row');
  return placeOf(family);
}
