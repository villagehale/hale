/**
 * Pure (I/O-free) shaping for a family's structured location: country, province /
 * state, city, postal code. Shared by onboarding (Phase C) and the Family page so
 * normalization is one source of truth.
 *
 * The postal code is the finest grain Hale stores (for booking). It is NEVER
 * surfaced precisely (rule #1): the discovery-facing areaCoarse is DERIVED as the
 * coarse postal prefix (Canadian FSA / UK outward code / US ZIP3) — the part
 * before the first space, else the first three characters — falling back to the
 * city when no postal code is set. Everything is nullable: a family opts in to
 * local discovery by filling these, and clearing them all opts back out.
 */

export interface LocationInput {
  country?: string;
  province?: string;
  city?: string;
  postalCode?: string;
}

/** The persisted shape: families' four location columns plus the derived areaCoarse. */
export interface NormalizedLocation {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  /** DERIVED coarse area for discovery (rule #1): the postal prefix, else the city. */
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
 * The coarse area Hale surfaces for discovery, never the precise postal code
 * (rule #1): the part of the postal code before the first space (Canadian FSA
 * "M5V", UK outward "SW1A"), or — when there is no space (US ZIP) — the first
 * three characters ("90210" → "902"). Falls back to the city when no postal code
 * is set, and to null when neither is.
 */
export function deriveAreaCoarse(postalCode: string | null, city: string | null): string | null {
  if (postalCode) {
    const spaceIndex = postalCode.indexOf(' ');
    // A space marks the coarse unit (Canadian FSA / UK outward code) — keep it
    // whole. A contiguous code (US ZIP) has no space, so take ZIP3.
    return spaceIndex === -1 ? postalCode.slice(0, 3) : postalCode.slice(0, spaceIndex);
  }
  return city;
}

/**
 * Trim each field; an empty field becomes null. The postal code is upper-cased and
 * inner whitespace collapsed (Canadian FSAs read "M5V 2T6"). areaCoarse is DERIVED
 * (the coarse prefix, else the city) so the discovery layer — which reads
 * areaCoarse — only ever sees a coarse area, never the full address (rule #1).
 */
export function normalizeLocation(input: LocationInput): NormalizedLocation {
  const postalCode = clean(input.postalCode)?.toUpperCase().replace(/\s+/g, ' ') ?? null;
  const city = clean(input.city);
  return {
    country: clean(input.country),
    province: clean(input.province),
    city,
    postalCode,
    areaCoarse: deriveAreaCoarse(postalCode, city),
  };
}

/**
 * The only region Hale is compliance-cleared to onboard today (hard rule #1):
 * Canada. Broadening is a DELIBERATE per-market program (GDPR/COPPA + regional
 * data residency), not an assumption — so onboarding rejects an explicit
 * non-Canadian country until that market is cleared. A null country (the
 * Canada-first baseline / unspecified) passes; the country NAME is matched
 * case-insensitively (Google Places and the free-text field both return the
 * display name, e.g. "Canada").
 */
const SUPPORTED_COUNTRY_ALIASES = new Set(['canada', 'ca', 'can']);

export function isOnboardingRegionSupported(country: string | null): boolean {
  if (country === null) return true;
  return SUPPORTED_COUNTRY_ALIASES.has(country.trim().toLowerCase());
}
