import type { LocationInput } from '~/lib/family/location-input';

/**
 * Pure (I/O-free) mapping from a Google Places "address component" list to Hale's
 * structured LocationInput. Kept out of the React component so the field mapping —
 * which Google component type fills which Hale field — is unit-testable without the
 * Maps script or a browser. rule #1: we keep ONLY country / province / city /
 * postal code; the street line is intentionally dropped (booking-time detail, not
 * stored here).
 *
 * The shape mirrors `google.maps.places.AddressComponent` from the Places (New)
 * library: each entry has `types: string[]` plus `longText` / `shortText`. We type
 * it structurally (not via the global) so this module needs no DOM types.
 */
export interface PlaceAddressComponent {
  types: string[];
  longText: string | null;
  shortText: string | null;
}

function pick(
  components: readonly PlaceAddressComponent[],
  type: string,
  prefer: 'long' | 'short',
): string | undefined {
  const match = components.find((c) => c.types.includes(type));
  if (!match) {
    return undefined;
  }
  const value = prefer === 'short' ? match.shortText : match.longText;
  return value ?? undefined;
}

/**
 * Reduce a place's address components to the four coarse fields Hale stores.
 * `city` prefers `locality`, falling back to `postal_town` (UK) then the
 * administrative level 2 (some regions surface the municipality there). Province /
 * state is the short code (e.g. "ON", "CA"); country is the long name.
 */
export function parsePlaceAddress(
  components: readonly PlaceAddressComponent[],
): LocationInput {
  return {
    country: pick(components, 'country', 'long'),
    province: pick(components, 'administrative_area_level_1', 'short'),
    city:
      pick(components, 'locality', 'long') ??
      pick(components, 'postal_town', 'long') ??
      pick(components, 'administrative_area_level_2', 'long'),
    postalCode: pick(components, 'postal_code', 'long'),
  };
}
