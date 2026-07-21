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

// ── City autocomplete + centroid (switcher typeahead + onboarding map) ────────
//
// Google Places Autocomplete (New) gives Google-Maps-style fuzzy typeahead —
// partial input, typo tolerance, live locality suggestions — restricted to Canadian
// cities (includedPrimaryTypes ["(cities)"], includedRegionCodes ["ca"]). Predictions
// carry NO coordinates; the SELECTED prediction is resolved to its city centroid via
// Place Details. A per-search sessionToken threads the autocomplete calls + the one
// details call into a single BILLED session (autocomplete session pricing).
//
// Privacy (rule #1): only the coarse city text the parent types leaves the client,
// and the only coordinate ever produced is the locality CENTROID (city centre, never
// an address) — used client-side to centre a city-level map and never persisted;
// completeOnboarding / the switcher store only {city, province}.

const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACES_DETAILS_URL = 'https://places.googleapis.com/v1/places';

/** A coarse Canadian city — the identity a saved area and a search result share
 * (rule #1: no coordinates). */
export interface CityCandidate {
  city: string;
  province: string | null;
}

/** An autocomplete prediction: a coarse {city, province} plus the Place id needed to
 * resolve its centroid on selection, and a ready-to-render description. Extends
 * CityCandidate so existing {city, province} consumers stay source-compatible. */
export interface CityPrediction extends CityCandidate {
  placeId: string;
  /** Google's structured display text, e.g. "Toronto, ON, Canada". */
  description: string;
}

/** A coarse Canadian city plus its centroid (the locality's centre, never an
 * address — rule #1). Resolved from a selected prediction via Place Details. */
export interface CityCentroid extends CityCandidate {
  lat: number;
  lng: number;
}

const CITY_SUGGESTION_MAX = 6;

/** Fields each prediction needs — the place id (to resolve the centroid on select)
 * plus the structured display text. No coordinate field is requested; predictions
 * are coordinate-free (rule #1). */
const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';

/** Details fields for a selected city: the centroid + the canonical name/province.
 * The place is a single locality, so `location` is the city centre (rule #1). */
const CITY_DETAILS_FIELD_MASK = 'location,displayName,addressComponents';

/** The province short code from a prediction's secondary text ("ON, Canada" → "ON";
 * "Canada" / absent → null). The authoritative province for a SELECTED city comes
 * from Place Details; this is the best-effort display/dedup value. */
function provinceFromSecondary(secondary: string | undefined): string | null {
  const first = secondary?.split(',')[0]?.trim();
  if (!first || first.toLowerCase() === 'canada') return null;
  return first;
}

interface PlacesAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
    };
  }>;
}

/**
 * Map a Places Autocomplete (New) response to up to CITY_SUGGESTION_MAX coarse
 * predictions. A suggestion with no place id or no main-text city is skipped;
 * duplicate (city, province) collapse. Coordinates are never read here (rule #1).
 */
export function parseCityPredictions(raw: unknown): CityPrediction[] {
  const suggestions = (raw as PlacesAutocompleteResponse)?.suggestions ?? [];
  const out: CityPrediction[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const prediction = suggestion?.placePrediction;
    const placeId = prediction?.placeId?.trim();
    const city = prediction?.structuredFormat?.mainText?.text?.trim();
    if (!placeId || !city) continue;
    const province = provinceFromSecondary(prediction?.structuredFormat?.secondaryText?.text);
    const key = `${city.toLowerCase()}|${(province ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const description =
      prediction?.text?.text?.trim() || (province ? `${city}, ${province}` : city);
    out.push({ placeId, city, province, description });
    if (out.length >= CITY_SUGGESTION_MAX) break;
  }
  return out;
}

/** The single HTTP edge for autocomplete, injected so tests exercise the parse/guard
 * logic with a fake instead of a real Google call. */
export interface CityAutocompleteClient {
  autocomplete(input: string, sessionToken?: string): Promise<unknown>;
}

/**
 * Fuzzy-search Canadian cities for a typeahead, or [] on any miss/failure. Never
 * throws — best-effort, so a transport/quota error degrades to an empty list rather
 * than a 500 (rule #8 boundary). Pass the search session's token so autocomplete +
 * the eventual details call bill as one session.
 */
export async function autocompleteCanadianCities(
  input: string,
  sessionToken?: string,
  client: CityAutocompleteClient = defaultCityAutocompleteClient(),
): Promise<CityPrediction[]> {
  const trimmed = input.trim();
  if (!trimmed) return [];
  try {
    return parseCityPredictions(await client.autocomplete(trimmed, sessionToken));
  } catch {
    return [];
  }
}

/**
 * Live Places Autocomplete (New) client. Same key resolution as the other Places
 * clients (reuse, not a new provider). With no key, returns null-shaped (no
 * suggestions) so autocompleteCanadianCities yields [].
 */
export function defaultCityAutocompleteClient(): CityAutocompleteClient {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return {
    async autocomplete(input: string, sessionToken?: string): Promise<unknown> {
      if (!apiKey) return { suggestions: [] };
      const body: Record<string, unknown> = {
        input,
        // The (cities) collection keeps predictions to localities; region 'ca' is the
        // only compliance-cleared onboarding market (rule #1).
        includedPrimaryTypes: ['(cities)'],
        includedRegionCodes: ['ca'],
        languageCode: 'en',
      };
      if (sessionToken) body.sessionToken = sessionToken;
      const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PLACES_ATTEMPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`places autocomplete failed: ${res.status}`);
      }
      return res.json();
    },
  };
}

interface PlaceDetailsResponse {
  displayName?: { text?: string };
  addressComponents?: Array<{ shortText?: string; longText?: string; types?: string[] }>;
  location?: { latitude?: number; longitude?: number };
}

/**
 * Map a Place Details (New) response to {city, province, centroid}, or null when it
 * carries no centroid (nothing coarse to centre on). Province is read from
 * administrative_area_level_1 (null when absent). The coordinates are the locality
 * centre only (rule #1).
 */
export function parseCityDetails(raw: unknown): CityCentroid | null {
  const place = raw as PlaceDetailsResponse;
  const city = place?.displayName?.text?.trim();
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!city || typeof lat !== 'number' || typeof lng !== 'number') return null;
  const provinceComponent = place?.addressComponents?.find((component) =>
    component.types?.includes('administrative_area_level_1'),
  );
  return { city, province: provinceComponent?.shortText?.trim() || null, lat, lng };
}

/** The single HTTP edge for Place Details, injected so tests exercise the parse/guard
 * logic with a fake instead of a real Google call. */
export interface CityDetailsClient {
  details(placeId: string, sessionToken?: string): Promise<unknown>;
}

/**
 * Resolve a selected place id to its coarse {city, province, centroid}, or null on
 * any miss/failure. Never throws — a transport/quota error just leaves the map where
 * it is (rule #8 boundary). Pass the search session's token to close the billed
 * session opened by autocompleteCanadianCities.
 */
export async function resolveCityPlace(
  placeId: string,
  sessionToken?: string,
  client: CityDetailsClient = defaultCityDetailsClient(),
): Promise<CityCentroid | null> {
  const trimmed = placeId.trim();
  if (!trimmed) return null;
  try {
    return parseCityDetails(await client.details(trimmed, sessionToken));
  } catch {
    return null;
  }
}

/**
 * Live Place Details (New) client. Same key resolution as the other Places clients.
 * With no key, returns an empty object so resolveCityPlace yields null.
 */
export function defaultCityDetailsClient(): CityDetailsClient {
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  return {
    async details(placeId: string, sessionToken?: string): Promise<unknown> {
      if (!apiKey) return {};
      const url = new URL(`${PLACES_DETAILS_URL}/${encodeURIComponent(placeId)}`);
      if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': CITY_DETAILS_FIELD_MASK,
        },
        signal: AbortSignal.timeout(PLACES_ATTEMPT_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`place details failed: ${res.status}`);
      }
      return res.json();
    },
  };
}
