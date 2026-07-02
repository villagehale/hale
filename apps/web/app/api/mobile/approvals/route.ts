import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadPendingApprovals } from '~/lib/dashboard/queries';
import type { MobileApprovalsResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/approvals — the native Approvals queue: this family's drafted
 * actions still awaiting a decision (rule #4). A 13+ child's raw drafted payload is
 * redacted inside loadPendingApprovals (rule #1). This route never touches the DB.
 * Auth() is the 401 gate.
 *
 * Approve/decline are WRITES handled by the existing POST /api/actions/:id/approve
 * and .../decline routes, now Bearer-callable through the middleware bridge — the
 * native app POSTs there directly, so those aren't duplicated here.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const approvals = await loadPendingApprovals();

  const body: MobileApprovalsResponse = { approvals };
  return NextResponse.json(body);
}
