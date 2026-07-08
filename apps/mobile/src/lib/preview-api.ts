/**
 * The PRE-AUTH anonymous village preview. Before any account exists, the
 * onboarding flow can show a REAL sample of what Hale finds — by POSTing a coarse,
 * identity-free body to the same unauthenticated /api/preview endpoint the web funnel
 * uses. The privacy contract (rule #1) is upheld on the client too: the body carries
 * ONLY a derived stage (never a DOB), a coarse area (city or FSA, never a precise
 * address or postal code), and optional interest strings — no name, no child id.
 *
 * It must never block or fake the flow (rule #8): a non-200, a network error, a
 * timeout, or a malformed body all resolve to an empty list, and the preview screen
 * skips the teaser gracefully. A genuine failure is swallowed HERE (a preview is
 * best-effort, not a gate) — not masked in business logic elsewhere.
 *
 * Kept native-import-free so the request shaping is unit-testable under the src/lib
 * runner; it reads only API_BASE and the global fetch.
 */

import type { FamilyStage } from './family-stage';
import type { DraftLocation } from './onboarding-draft';

/** One sample activity from the preview — the honest subset the teaser renders.
 * Mirrors the web PreviewActivity projection (title/summary/coverageNote). */
export interface PreviewActivity {
  title: string;
  summary: string;
  coverageNote: string;
}

export interface PreviewRequest {
  stage: FamilyStage;
  areaCoarse: string;
  interests: string[];
}

/** How long to wait before giving up and skipping the teaser. The preview runs a
 * model call server-side, so it needs more than the tight API default — but it can
 * never hold onboarding hostage, so the wait is bounded. */
const PREVIEW_TIMEOUT_MS = 12_000;

/**
 * The coarse area for the preview body (rule #1): the city if given, else the
 * postal code's forward sortation area (its first three characters) — never the
 * full postal code, never a precise address. `null` when neither is set, which the
 * caller treats as "nothing to preview".
 */
export function areaCoarseFromLocation(location: DraftLocation): string | null {
  const city = location.city?.trim();
  if (city) return city;
  const fsa = location.postalCode?.trim().replace(/\s+/g, '').slice(0, 3).toUpperCase();
  return fsa ? fsa : null;
}

/**
 * Run the anonymous preview against the given API origin (injected so this stays
 * native-import-free and testable — the screen passes API_BASE). Resolves to the
 * sample activities, or `[]` on any failure so the flow is never blocked and
 * results are never fabricated. A `teenager` stage returns `[]` from the server by
 * design (rule #1) — the caller shows the honest teen line rather than treating
 * empty as an error.
 */
export async function fetchPreview(
  request: PreviewRequest,
  apiBase: string | undefined,
): Promise<PreviewActivity[]> {
  if (!apiBase) return [];

  let res: Response;
  try {
    res = await fetch(`${apiBase}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  const body = (await res.json().catch(() => null)) as { activities?: unknown } | null;
  if (!body || !Array.isArray(body.activities)) return [];
  // Per-element shape check: the honesty guarantee is structural — a malformed
  // element must never render an empty-title teaser card.
  return body.activities.filter(
    (a): a is PreviewActivity =>
      typeof (a as PreviewActivity)?.title === 'string' &&
      (a as PreviewActivity).title.trim().length > 0 &&
      typeof (a as PreviewActivity)?.summary === 'string',
  );
}
