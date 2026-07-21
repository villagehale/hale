import { NextResponse } from 'next/server';
import { clientIp, enforceRateLimit } from '~/lib/rate-limit/apply';
import { autocompleteCanadianCities } from '~/lib/village/geocode';

// Node runtime: the search calls the Places provider over the network.
export const runtime = 'nodejs';

/**
 * GET /api/onboarding/city-search?q=&session= — the PRE-AUTH onboarding city typeahead.
 *
 * A GET route handler rather than a Server Action: Next.js SERIALIZES a client's
 * Server-Action POSTs, so when Places latency exceeds the client debounce the debounced
 * keystroke lookups queue behind each other and suggestion latency compounds. GET
 * requests run in parallel (and are cacheable), so the freshest keystroke isn't stuck
 * behind stale ones (WP-12). resolveCityAction stays a Server Action — a selection is a
 * single call, not a stream.
 *
 * Capped per CLIENT IP against the paid Places provider (rule: no uncapped provider
 * route); a 2-char floor skips single-keystroke lookups before the rate check. Coarse
 * only (rule #1): predictions carry no coordinates. The optional session token threads
 * the search session so autocomplete + the eventual details call bill as one session.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  if (q.trim().length < 2) {
    return NextResponse.json({ predictions: [] });
  }

  const limited = await enforceRateLimit('city-search', clientIp(req));
  if (limited) return limited;

  const sessionToken = url.searchParams.get('session') ?? undefined;
  const predictions = await autocompleteCanadianCities(q, sessionToken);
  return NextResponse.json({ predictions });
}
