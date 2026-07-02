import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadCompanion } from '~/lib/companion/queries';
import { loadRecentLogs } from '~/lib/companion/recent-logs';
import type { MobileCompanionResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/companion — the native Companion tab: each child's live-derived
 * companion view plus the recent quick-log timeline. loadRecentLogs drops a 13+
 * child's episodes internally (rule #1); this route never touches the DB. Auth() is
 * the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [children, recentLogs] = await Promise.all([loadCompanion(), loadRecentLogs()]);

  const body: MobileCompanionResponse = { children, recentLogs };
  return NextResponse.json(body);
}
