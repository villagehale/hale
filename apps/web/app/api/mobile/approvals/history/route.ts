import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadResolvedActions } from '~/lib/dashboard/queries';
import type { MobileApprovalsHistoryResponse } from '../../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/approvals/history — the Approvals History segment: this family's
 * RESOLVED actions (executed / declined / reverted / held), newest first. A 13+
 * child's raw payload is redacted inside loadResolvedActions (rule #1) and the
 * intent label reuses the live Approvals card's. This route never touches the DB.
 * Auth() is the 401 gate — the loader re-resolves the family from the same session,
 * so an unauthenticated caller gets 401, never an empty payload.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const history = await loadResolvedActions();

  const body: MobileApprovalsHistoryResponse = { history };
  return NextResponse.json(body);
}
