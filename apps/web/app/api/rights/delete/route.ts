import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { requestErasure } from '~/lib/rights/delete';

// Node runtime: the scheduler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

// Confirm-gated: this removes EVERYTHING Hale holds about the family, so the
// request must carry an explicit confirmation, never a bare POST.
const bodySchema = z.object({ confirm: z.literal(true) });

/**
 * POST /api/rights/delete — a parent requests deletion of their account/family
 * (PIPEDA/Law 25 right-to-erasure). This does NOT hard-delete: the scheduler
 * stamps a grace-period deletion date and writes the audit row (rule #6); the
 * worker erases the family only after the grace lapses (reversible until then).
 * Auth mirrors the share route (rule #1): dev-preview 501, signed out 401, no
 * family / no user 403. A request without confirm:true is 400 — nothing is scheduled.
 *
 * WHOSE erasure this is depends on the caller's seat, and `requestErasure` decides it
 * (VIL-355): a co-parent is departed on their own and answered `departed` with the tally
 * of what was undone, so the response can never let them believe the household's record
 * went with them. Every other role gets the scheduled family, unchanged.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to delete your account' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const result = await requestErasure(database, { familyId, actorUserId });

  if (result.outcome === 'co_parent_departed') {
    const { channelRevoked, consentWithdrawn, threadRetained } = result.departure;
    return NextResponse.json(
      { status: 'departed', channelRevoked, consentWithdrawn, threadRetained },
      { status: 202 },
    );
  }

  return NextResponse.json(
    { status: 'scheduled', scheduledDeletionAt: result.scheduledDeletionAt.toISOString() },
    { status: 202 },
  );
}
