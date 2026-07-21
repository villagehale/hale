import { NextResponse } from 'next/server';
import { searchVillageAction } from '~/lib/village/ai-search-action';
import type { MobileVillageAiSearchResponse } from '../../types';

// Node runtime: the wrapped action makes an LLM (Anthropic SDK) call for the intent parse.
export const runtime = 'nodejs';
// The wrapped action kicks a FRESH discovery run in after() (a bounded Anthropic call
// far longer than the ~10s default). Match the discovery crons (maxDuration 300) so the
// after() work isn't killed mid-run (mirrors api/mobile/village/search/route.ts:11).
export const maxDuration = 300;

/**
 * POST /api/mobile/village/ai-search — the native counterpart to the web Village
 * natural-language search bar. A thin wrapper over the SHARED searchVillageAction:
 * auth + family scope + the per-family rate limit + the teen-redacted candidate pool
 * all live in the action (rule #1), reached here through the Bearer→cookie bridge that
 * makes its auth() resolve. This route only shapes the outcome into an HTTP response —
 * unauthenticated → 401, no family → 403, a limiter denial → 429 (+Retry-After), never
 * a swallowed error (rule #8). Read-only search: no audit row of its own.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = (await req.json().catch(() => null)) as { prompt?: unknown } | null;
  if (!raw || typeof raw.prompt !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await searchVillageAction(raw.prompt);
  switch (result.status) {
    case 'unauthenticated':
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    case 'no_family':
      return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
    case 'rate_limited':
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(result.retryAfter) } },
      );
    case 'ok': {
      const body: MobileVillageAiSearchResponse = {
        interpretation: result.interpretation,
        results: result.results,
        degraded: result.degraded,
        discoveryKicked: result.discoveryKicked,
      };
      return NextResponse.json(body);
    }
  }
}
