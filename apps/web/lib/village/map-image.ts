import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';

/**
 * Server-side Static Maps thumbnail for a village candidate's PUBLIC venue point.
 * The map is fetched with the server Maps key and its bytes are streamed to the
 * client, so the key never reaches the app (rule #1). The plotted point is the
 * candidate's already-resolved PUBLIC venue coordinate — never the family's home.
 *
 * The Static Maps API may not be enabled on the project yet: the route treats ANY
 * non-200 upstream response as "no map" (returns 204), so a thumbnail simply
 * appears once the API is turned on, with no code change or release. No fallback
 * image, no error state — absence is the degraded state.
 *
 * The DB read lives HERE (a shared lib), not in the /api/mobile route — mobile
 * routes must never build queries or hold a db handle (rule #1 tripwire).
 */

const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';

/**
 * The PUBLIC venue coordinate for a candidate, scoped to the caller's own family
 * (rule #1) — resolves the family from the session id, then reads the candidate's
 * already-stored public lat/lng. Returns null when there is no such candidate in
 * the family or it has no venue point (an online / no-venue activity, and every
 * teen-redacted card — whose coordinates are nulled at the feed mapper — so a
 * teen's activity is never plotted). Never plots the family's home.
 */
export async function readCandidateVenuePoint(
  externalAuthId: string,
  candidateId: string,
  database: Database = defaultDb(),
): Promise<{ lat: number; lng: number } | null> {
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) return null;

  const rows = await database
    .select({
      lat: schema.villageCandidates.lat,
      lng: schema.villageCandidates.lng,
    })
    .from(schema.villageCandidates)
    .where(
      and(
        eq(schema.villageCandidates.id, candidateId),
        eq(schema.villageCandidates.familyId, familyId),
      ),
    )
    .limit(1);

  const candidate = rows[0];
  if (!candidate || candidate.lat === null || candidate.lng === null) {
    return null;
  }
  return { lat: candidate.lat, lng: candidate.lng };
}

/** Reuse the project's single configured Maps key, preferring a server-only key
 * when present — same resolution order as geocode.ts's defaultGeocodeClient. */
export function staticMapApiKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
}

/** Builds the Static Maps request URL for a public venue point: a single marker at
 * the coordinate, a neighbourhood-level zoom, and a compact 2x thumbnail. */
export function buildStaticMapUrl(args: {
  lat: number;
  lng: number;
  apiKey: string;
  widthPx?: number;
  heightPx?: number;
}): string {
  const width = args.widthPx ?? 320;
  const height = args.heightPx ?? 160;
  const center = `${args.lat},${args.lng}`;
  const params = new URLSearchParams({
    center,
    zoom: '15',
    size: `${width}x${height}`,
    scale: '2',
    markers: `color:0x2f6f4e|${center}`,
    key: args.apiKey,
  });
  return `${STATIC_MAP_URL}?${params.toString()}`;
}
