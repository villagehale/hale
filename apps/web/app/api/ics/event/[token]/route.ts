import { db } from '~/lib/db';
import { loadEventInvite } from '~/lib/loop/ics-invite';

// Node runtime: the read goes through Drizzle/raw pg, which the edge runtime can't run.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ token: string }>;
}

/**
 * GET /api/ics/event/:token — the public, unauthenticated single-event calendar file
 * (VIL-249). The token is the only handle; a malformed, forged, revoked or deleted-event
 * token resolves nothing and returns the SAME 404, so the endpoint never distinguishes
 * "no such event" from "not yours". With no DATABASE_URL (e.g. a static preview build)
 * there is nothing to resolve, so it 404s rather than throwing. `no-store` keeps a
 * re-fetch live — the file's SEQUENCE rises as the event changes.
 */
export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return new Response('Not found', { status: 404 });
  }

  const { token } = await context.params;
  const ics = await loadEventInvite(db(), token, new Date());
  if (ics === null) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="invite.ics"',
      'cache-control': 'no-store',
    },
  });
}
