/**
 * Server-side venue geocoding for the village map. Resolves a candidate's venue
 * (its title) to PUBLIC coordinates via Google Places Text Search (New) — the
 * same Places product already enabled for onboarding address autocomplete, so no
 * new API needs enabling. Runs only on the server with the Maps key; the precise
 * family home is NEVER sent to Google — we disambiguate with the family's COARSE
 * area only (FSA / city), and we store only the resolved PUBLIC place location
 * (rule #1).
 *
 * A venue that can't be resolved (online / no-venue activity, an ambiguous title,
 * a transport/quota error) yields null — the candidate stays list-only with no
 * pin. geocodeVenue NEVER throws: a geocode is a best-effort enrichment, not a
 * user action, and one bad lookup must not abort a discovery run (rule #8 applies
 * to business logic; this is an explicit best-effort boundary).
 */

const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Radius (metres) of the locationBias circle: wide enough to cover a family's
 * FSA/city, tight enough to keep a same-named venue in another city out of the
 * top result. */
const BIAS_RADIUS_METERS = 30000;

/** Only the fields we persist — keeps the response (and any log) minimal.
 * websiteUri is a Places "Pro" SKU field; we request it so a candidate without
 * an LLM-supplied source_url can link straight to the venue's real site rather
 * than a Google search fallback. `id`, `rating`, and `userRatingCount` are the
 * enrichment fields the metadata build renders: the stable Places id (for a
 * future re-enrichment by id) and the venue's PUBLIC rating + count — surfaced
 * ONLY when Places actually returns them (no fabrication). rating/count bill
 * under the Enterprise SKU (as does websiteUri, already in the mask — the call
 * was Enterprise-billed before them); the mask stays tight to bound cost. */
const FIELD_MASK =
  'places.id,places.location,places.displayName,places.formattedAddress,places.websiteUri,places.rating,places.userRatingCount';

export interface GeocodeResult {
  lat: number;
  lng: number;
  venueName: string;
  venueAddress: string;
  /** The venue's public website, when Places has one — the real
   * details/registration URL we prefer over a Google-search fallback. */
  website?: string;
  /** The stable Google Places id for this venue — stored so a future
   * re-enrichment can look it up by id rather than re-geocoding. */
  placeId?: string;
  /** The venue's PUBLIC Google rating (0.0–5.0), when Places has one. Undefined
   * when Places returns none — the card then shows NO rating (never a placeholder). */
  rating?: number;
  /** How many public ratings the average rests on, when Places has it. */
  ratingCount?: number;
}

/** Centroid used to bias a venue lookup toward the family's coarse area. Always
 * the COARSE area centre — never a precise home (rule #1). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** The single HTTP edge, injected so tests exercise the parsing/guard logic with
 * a fake instead of a real Google call (no network in tests). The optional
 * `bias` biases (does not restrict) results toward a centre — so a same-named
 * venue in another city no longer wins the top result. */
export interface GeocodeClient {
  searchText(textQuery: string, bias?: LatLng): Promise<unknown>;
}

/**
 * Builds the disambiguating query: the venue/title plus the family's COARSE area
 * only (e.g. "Riverdale Library M4K"). Never the precise home address — the
 * coarse area is the finest grain that leaves the server (rule #1).
 */
export function buildTextQuery(title: string, areaCoarse: string): string {
  return `${title} ${areaCoarse}`.trim();
}

/** Shape we read out of the Places Text Search (New) response. */
interface PlacesResponse {
  places?: Array<{
    id?: string;
    location?: { latitude?: number; longitude?: number };
    displayName?: { text?: string };
    formattedAddress?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
  }>;
}

function parseFirstPlace(raw: unknown): GeocodeResult | null {
  const body = raw as PlacesResponse;
  const place = body?.places?.[0];
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    lat,
    lng,
    venueName: place?.displayName?.text ?? '',
    venueAddress: place?.formattedAddress ?? '',
    website: place?.websiteUri,
    placeId: place?.id,
    // Only surface a rating Places actually returned — never a default/placeholder.
    rating: typeof place?.rating === 'number' ? place.rating : undefined,
    ratingCount:
      typeof place?.userRatingCount === 'number' ? place.userRatingCount : undefined,
  };
}

/**
 * Resolve one venue to PUBLIC coordinates, or null on any miss/failure. Never
 * throws. `client` defaults to the live Places client; tests inject a fake.
 * `bias` is the COARSE area centre (rule #1) — supplying it keeps a same-named
 * venue in another city out of the top result; omitting it preserves the prior
 * text-only behaviour.
 */
export async function geocodeVenue(
  title: string,
  areaCoarse: string,
  client: GeocodeClient = defaultGeocodeClient(),
  bias?: LatLng,
): Promise<GeocodeResult | null> {
  const query = buildTextQuery(title, areaCoarse);
  if (!query) return null;
  try {
    const raw = await client.searchText(query, bias);
    return parseFirstPlace(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve a COARSE area string (e.g. "M4K", "Halton Hills") to its centre, or
 * null on any miss/failure. Never throws — this feeds the venue-lookup bias, and
 * a missing centre just falls back to the prior text-only search. Only the coarse
 * area is ever sent (rule #1).
 */
export async function geocodeArea(
  areaCoarse: string,
  client: GeocodeClient = defaultGeocodeClient(),
): Promise<LatLng | null> {
  const area = areaCoarse.trim();
  if (!area) return null;
  try {
    const resolved = parseFirstPlace(await client.searchText(area));
    return resolved ? { lat: resolved.lat, lng: resolved.lng } : null;
  } catch {
    return null;
  }
}

/**
 * Live Places Text Search (New) client. Uses the server-side Maps key. We reuse
 * NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (the project's single configured Maps key,
 * already used for Places autocomplete) unless a dedicated server key
 * GOOGLE_MAPS_API_KEY is set — preferring a server-only key when present. With no
 * key, searchText returns null-shaped (no places), so geocodeVenue yields null.
 */
export function defaultGeocodeClient(): GeocodeClient {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return {
    async searchText(textQuery: string, bias?: LatLng): Promise<unknown> {
      if (!apiKey) return { places: [] };
      const body: Record<string, unknown> = { textQuery, maxResultCount: 1 };
      if (bias) {
        body.locationBias = {
          circle: {
            center: { latitude: bias.lat, longitude: bias.lng },
            radius: BIAS_RADIUS_METERS,
          },
        };
      }
      const res = await fetchOnceRetryingTransient(apiKey, body);
      if (!res.ok) {
        throw new Error(`places searchText failed: ${res.status}`);
      }
      return res.json();
    },
  };
}

/** Statuses worth one more attempt: a transient Google-side blip. A 4xx (bad key,
 * quota exhausted, invalid argument) is deterministic — retrying only wastes a
 * call and risks a storm, so it fails fast. */
function isTransient(status: number): boolean {
  return status >= 500;
}

/**
 * One Places call, with a SINGLE retry on a transient (5xx / network) failure —
 * cost discipline: never a retry storm. A 4xx fails immediately (a bad/invalid
 * key won't heal on a retry); a resolved 5xx or a thrown network error gets one
 * more shot, then the caller's guard degrades the enrichment to null.
 */
const PLACES_ATTEMPT_TIMEOUT_MS = 10_000;

async function fetchOnceRetryingTransient(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const doFetch = () =>
    fetch(PLACES_TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      // Bounded per attempt: a hung Places request must not stall the whole
      // discovery Promise.all until the platform kills the function.
      signal: AbortSignal.timeout(PLACES_ATTEMPT_TIMEOUT_MS),
    });
  try {
    const res = await doFetch();
    if (res.ok || !isTransient(res.status)) return res;
  } catch {
    // A network throw is transient — fall through to the single retry.
  }
  return doFetch();
}

// ── Forward city search (the region switcher's typeahead) ─────────────────────
//
// Reuses the SAME Places Text Search (New) provider + auth as venue geocoding — no
// new provider (the region-switcher search must not add an integration). The one
// difference is the request: it asks for up to CITY_SEARCH_MAX locality results
// (not one venue) and a mask carrying the address components, so each candidate
// resolves to a coarse {city, province} — never coordinates (rule #1). Restricted
// to Canada (regionCode 'CA'), the only region Hale is compliance-cleared for.

/** A coarse city candidate for the region switcher — no coordinates (rule #1). */
export interface CityCandidate {
  city: string;
  province: string | null;
}

const CITY_SEARCH_MAX = 6;

/** Only the fields the switcher needs: the locality name + its address components
 * (to read the province from administrative_area_level_1). No location field is
 * requested — the search never returns or stores coordinates (rule #1). */
const CITY_FIELD_MASK = 'places.displayName,places.addressComponents';

/** The single HTTP edge for city search, injected so tests exercise the
 * parse/guard logic with a fake instead of a real Google call. */
export interface CitySearchClient {
  searchCities(query: string): Promise<unknown>;
}

interface PlacesCityResponse {
  places?: Array<{
    displayName?: { text?: string };
    addressComponents?: Array<{ shortText?: string; longText?: string; types?: string[] }>;
  }>;
}

/**
 * Map a Places locality response to up to CITY_SEARCH_MAX coarse {city, province}
 * candidates, province read from the administrative_area_level_1 component (null
 * when absent). Duplicates collapse; a place with no name is skipped. Coordinates
 * are never read — the switcher deals only in coarse names (rule #1).
 */
export function parseCityCandidates(raw: unknown): CityCandidate[] {
  const places = (raw as PlacesCityResponse)?.places ?? [];
  const out: CityCandidate[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const city = place?.displayName?.text?.trim();
    if (!city) continue;
    const provinceComponent = place?.addressComponents?.find((component) =>
      component.types?.includes('administrative_area_level_1'),
    );
    const province = provinceComponent?.shortText?.trim() || null;
    const key = `${city.toLowerCase()}|${(province ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ city, province });
    if (out.length >= CITY_SEARCH_MAX) break;
  }
  return out;
}

/**
 * Forward-search Canadian cities for the region switcher, or [] on any
 * miss/failure. Never throws — like venue geocoding this is best-effort, and a
 * transport/quota error must degrade to an empty list, not a 500 (rule #8
 * boundary). `client` defaults to the live Places client; tests inject a fake.
 */
export async function searchCanadianCities(
  query: string,
  client: CitySearchClient = defaultCitySearchClient(),
): Promise<CityCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    return parseCityCandidates(await client.searchCities(trimmed));
  } catch {
    return [];
  }
}

/**
 * Live Places city-search client. Same endpoint + key resolution as
 * defaultGeocodeClient (reuse, not a new provider); the request asks for locality
 * results in Canada with the city field mask. With no key, returns null-shaped (no
 * places) so searchCanadianCities yields [].
 */
export function defaultCitySearchClient(): CitySearchClient {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return {
    async searchCities(query: string): Promise<unknown> {
      if (!apiKey) return { places: [] };
      const res = await fetch(PLACES_TEXT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': CITY_FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query,
          maxResultCount: CITY_SEARCH_MAX,
          // Restrict to Canada (rule #1 compliance baseline); includedType keeps the
          // results to cities/towns rather than venues.
          regionCode: 'CA',
          includedType: 'locality',
        }),
        signal: AbortSignal.timeout(PLACES_ATTEMPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`places city search failed: ${res.status}`);
      }
      return res.json();
    },
  };
}
