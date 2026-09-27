import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { socialWatchlistEnabled } from '~/lib/social/flag';
import { acceptParentForward, drizzleForwardStore } from '~/lib/social/forward';

export const runtime = 'nodejs';

/**
 * POST /api/social/forward — internal ingest. Cron secret, flag on.
 * Flag off is a 404 with a named skip, so a dark deploy does not queue.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireCronSecret(req);
  if (denied) return denied;
  if (!socialWatchlistEnabled()) {
    return NextResponse.json({ skipped: 'flag_off' }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ skipped: 'invalid_body' }, { status: 400 });
  }
  const result = await acceptParentForward(drizzleForwardStore(db()), body);
  const status = result.status === 'queued' ? 200 : 400;
  return NextResponse.json(result, { status });
}
