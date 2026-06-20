/**
 * Pure (I/O-free) shaping for a family's structured location: country, province /
 * state, city, postal code. Shared by onboarding (Phase C) and the Family page so
 * normalization is one source of truth.
 *
 * The postal code is the finest grain Hale stores. It drives neighbourhood
 * discovery but is never surfaced precisely (rule #1); areaCoarse mirrors it for
 * back-compat with the existing discovery reads. Everything is nullable: a family
 * opts in to local discovery by filling these, and clearing them all opts back out.
 */

export interface LocationInput {
  country?: string;
  province?: string;
  city?: string;
  postalCode?: string;
}

/** The persisted shape: families' four location columns plus the mirrored areaCoarse. */
export interface NormalizedLocation {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  /** Mirrors postalCode so existing discovery reads keep working (rule #1: coarse). */
  areaCoarse: string | null;
}

function clean(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trim each field; an empty field becomes null. The postal code is upper-cased and
 * inner whitespace collapsed (Canadian FSAs read "M5V 2T6"), then mirrored into
 * areaCoarse so the discovery layer — which reads areaCoarse — stays accurate
 * without a separate write.
 */
export function normalizeLocation(input: LocationInput): NormalizedLocation {
  const postalCode = clean(input.postalCode)?.toUpperCase().replace(/\s+/g, ' ') ?? null;
  return {
    country: clean(input.country),
    province: clean(input.province),
    city: clean(input.city),
    postalCode,
    areaCoarse: postalCode,
  };
}
