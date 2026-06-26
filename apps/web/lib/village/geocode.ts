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
 * than a Google search fallback. */
const FIELD_MASK = 'places.location,places.displayName,places.formattedAddress,places.websiteUri';

export interface GeocodeResult {
  lat: number;
  lng: number;
  venueName: string;
  venueAddress: string;
  /** The venue's public website, when Places has one — the real
   * details/registration URL we prefer over a Google-search fallback. */
  website?: string;
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
    location?: { latitude?: number; longitude?: number };
    displayName?: { text?: string };
    formattedAddress?: string;
    websiteUri?: string;
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
      const res = await fetch(PLACES_TEXT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`places searchText failed: ${res.status}`);
      }
      return res.json();
    },
  };
}
