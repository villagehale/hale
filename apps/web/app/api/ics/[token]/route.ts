import { db } from '~/lib/db';
import { loadIcsFeed } from '~/lib/loop/ics-feed';

// Node runtime: the feed reads through Drizzle/raw pg, which the edge runtime can't run.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ token: string }>;
}

/**
 * GET /api/ics/:token — the public, unauthenticated ICS calendar-subscription feed
 * (VIL-219). The token is the only handle; an unknown or revoked token resolves nothing
 * and returns 404. With no DATABASE_URL (e.g. a static preview build) there is nothing
 * to resolve, so it 404s the same way rather than throwing. `no-store` keeps a
 * subscribing client re-fetching live rather than serving a stale cached feed.
 */
export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return new Response('Not found', { status: 404 });
  }

  const { token } = await context.params;
  const ics = await loadIcsFeed(db(), token, new Date());
  if (ics === null) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
