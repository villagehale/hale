import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import {
  buildStaticMapUrl,
  readCandidateVenuePoint,
  staticMapApiKey,
} from '~/lib/village/map-image';

export const runtime = 'nodejs';

const idSchema = z.string().uuid();

/** 204 = "no map for this one": no key, no coordinate, or the upstream Static Maps
 * API is not enabled / errored. The client renders a thumbnail ONLY on a 200, so a
 * 204 is silently the degraded state — a map appears when the API is enabled, with
 * no release. A FACTORY, not a shared instance: a Response is single-use, so every
 * request must get its own. */
const noMap = () => new NextResponse(null, { status: 204 });

/**
 * GET /api/mobile/village/map-image?candidateId=… — a Static Maps thumbnail of a
 * candidate's PUBLIC venue point, streamed through so the server Maps key never
 * reaches the app (rule #1). The plotted point is the candidate's already-resolved
 * public venue coordinate, never the family's home.
 *
 * The candidate read (family-scoped) lives behind readCandidateVenuePoint so this
 * route builds no query and holds no db handle (rule #1). A candidate from another
 * family, or one with no venue coordinate — which includes every teen-redacted card
 * (its lat/lng nulled at the feed mapper) — yields 204, so no teen activity is ever
 * plotted here. Auth() is the 401 gate.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const candidateId = new URL(req.url).searchParams.get('candidateId');
  const idParse = idSchema.safeParse(candidateId);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  const apiKey = staticMapApiKey();
  if (!apiKey) return noMap();

  const point = await readCandidateVenuePoint(externalAuthId, idParse.data);
  if (!point) return noMap();

  const url = buildStaticMapUrl({ lat: point.lat, lng: point.lng, apiKey });

  let upstream: Response;
  try {
    upstream = await fetch(url);
  } catch {
    // A transport error is the same degraded state as an upstream error (rule #1:
    // fail closed to "no map", never leak the key or the URL).
    return noMap();
  }
  if (!upstream.ok || !upstream.body) {
    return noMap();
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
      // A public venue thumbnail is stable; let the client cache it briefly.
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
