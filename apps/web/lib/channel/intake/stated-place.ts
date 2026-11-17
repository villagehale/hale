import { isEnabled } from '@hale/flags';
import { cityInCountry } from '~/lib/channel/off-domain/place';
import { type PostalContext, parseIntakePostal } from './derive';
import { type FirstTouchPlace, placeFromGivenFields } from './first-touch-place';
import { timezoneForIntakePostal } from './postal-zone';

/**
 * VIL-413 — a place the parent stated, for a US or Canadian family.
 *
 * Dark (`INTAKE_STATED_PLACE_ENABLED` unset): intake still places a family only
 * from a postal code or a ZIP. Lit: a city they named in the country they named
 * places them too, and the zone written at signup is that city's when every
 * area of it shares one zone. A street, a provider, and a place outside the US
 * and Canada do not. Nothing here writes a sentence to the parent.
 */

export const INTAKE_STATED_PLACE_ENABLED_ENV = 'INTAKE_STATED_PLACE_ENABLED';

/** Exact `true`. A trailing newline stays off. */
export function intakeStatedPlaceEnabled(): boolean {
  return isEnabled('intake-stated-place');
}

export type StatedCountry = 'CA' | 'US' | 'other';

export type IntakeLocation = Omit<PostalContext, 'timezone'> & {
  timezone: string | null;
  city?: string | null;
  province?: string | null;
};

/**
 * The zone those areas share, or null when they don't, or when there are none.
 * UTC is the "never set" zone, so a table miss is null rather than a clock.
 */
export function timezoneForAreas(country: 'CA' | 'US', areaKeys: readonly string[]): string | null {
  let zone: string | null = null;
  for (const key of areaKeys) {
    const next = timezoneForIntakePostal(country, key);
    if (next === 'UTC') return null;
    if (zone === null) zone = next;
    else if (zone !== next) return null;
  }
  return zone;
}

export function currencyForCountry(country: 'CA' | 'US'): 'CAD' | 'USD' {
  return country === 'US' ? 'USD' : 'CAD';
}

/** `CA` / `US` / `other` from the model's country field. Anything else is omitted. */
export function acceptStatedCountry(value: unknown): StatedCountry | null {
  if (value === 'CA' || value === 'US' || value === 'other') return value;
  if (typeof value !== 'string') return null;
  const folded = value.trim().toLowerCase();
  if (folded === 'canada' || folded === 'ca') return 'CA';
  if (folded === 'united states' || folded === 'us' || folded === 'usa') return 'US';
  if (folded === 'other') return 'other';
  return null;
}

/**
 * A place code can store. A postal code or ZIP wins, and a city is kept only
 * when it is that code's country. With no code, the city is kept only in the
 * country they named, and only when the postal table has exactly that place.
 */
export async function resolveStatedPlace(input: {
  postalCode: string | null;
  city: string | null;
  country: StatedCountry | null;
  region: string | null;
}): Promise<FirstTouchPlace | null> {
  const postal = placeFromGivenFields({ postalCode: input.postalCode, city: null });
  if (postal) {
    const parsed = parseIntakePostal(postal.postalCode ?? postal.areaCoarse);
    if (!parsed) return postal;
    const named =
      input.city && (input.country === null || input.country === parsed.countryCode)
        ? await cityInCountry(parsed.countryCode, input.city, input.region)
        : null;
    return {
      ...postal,
      ...(named ? { city: named.city, province: named.provinceOrState } : {}),
      country: parsed.country,
      countryCode: parsed.countryCode,
      timezone: parsed.timezone,
      currency: currencyForCountry(parsed.countryCode),
    };
  }
  if (input.country !== 'CA' && input.country !== 'US') return null;
  if (!input.city) return null;
  const named = await cityInCountry(input.country, input.city, input.region);
  if (!named) return null;
  return {
    kind: 'city',
    areaCoarse: named.city,
    postalCode: null,
    municipality: null,
    city: named.city,
    country: input.country === 'US' ? 'United States' : 'Canada',
    countryCode: input.country,
    province: named.provinceOrState,
    timezone: timezoneForAreas(input.country, named.areaKeys),
    currency: currencyForCountry(input.country),
  };
}

/** What signup writes. A city with no single zone still places the family; the clock stays unset. */
export function intakeLocationFromPlace(
  place:
    | FirstTouchPlace
    | {
        kind: 'postal' | 'city';
        areaCoarse: string;
        postalCode: string | null;
        city: string | null;
        country?: 'Canada' | 'United States';
        countryCode?: 'CA' | 'US';
        province?: string | null;
        timezone?: string | null;
      },
): IntakeLocation | null {
  if (place.kind === 'postal') {
    const parsed = parseIntakePostal(place.postalCode ?? place.areaCoarse);
    if (!parsed) return null;
    return {
      ...parsed,
      ...(place.city ? { city: place.city } : {}),
      ...(place.province ? { province: place.province } : {}),
    };
  }
  if (place.country !== 'Canada' && place.country !== 'United States') return null;
  if (place.countryCode !== 'CA' && place.countryCode !== 'US') return null;
  return {
    postalCode: null,
    areaCoarse: place.areaCoarse,
    country: place.country,
    countryCode: place.countryCode,
    timezone: place.timezone ?? null,
    city: place.city,
    province: place.province ?? null,
  };
}

/** CAD or USD for a stored place, when the flag is on and the place says. */
export function currencyOfPlace(
  place:
    | {
        currency?: 'CAD' | 'USD';
        kind?: 'postal' | 'city';
        postalCode?: string | null;
        areaCoarse?: string;
      }
    | null
    | undefined,
): 'CAD' | 'USD' | undefined {
  if (!intakeStatedPlaceEnabled() || !place) return undefined;
  if (place.currency === 'CAD' || place.currency === 'USD') return place.currency;
  const parsed = parseIntakePostal(
    place.postalCode ?? (place.kind === 'postal' ? (place.areaCoarse ?? null) : null),
  );
  if (!parsed) return undefined;
  return currencyForCountry(parsed.countryCode);
}
