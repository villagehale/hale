import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { requestTeenContentAccess, resolveActionTeenChild } from '~/lib/teen-access';

// Node runtime: the grant writer uses the Drizzle client + a transaction.
export const runtime = 'nodejs';

const bodySchema = z.object({
  /** The redacted approval row the parent wants to unlock. */
  actionId: z.string().uuid(),
});

/**
 * POST /api/teen-content-grant — a parent REQUESTS time-limited access to a 13+
 * teen's redacted approval content (rule #1 named exception). This does NOT reveal
 * anything: it records an explicit, audited (rule #6), time-limited grant REQUEST
 * (granted=false, expiring) and notifies the teen. The consume side (teen approves,
 * read honours an active grant) is a follow-up.
 *
 * Auth is the gate (rule #1): dev-preview refuses with 501 (never guess a family),
 * signed-out with 401, no-family with 403. A request whose action isn't this
 * family's, names no child, or concerns a non-teen is 404 — there is nothing to
 * unlock, and we never fabricate a target.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to request access' },
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
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const database = db();
  const [familyId, parentUserId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !parentUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const teenChildId = await resolveActionTeenChild(database, familyId, parsed.data.actionId);
  if (!teenChildId) {
    return NextResponse.json({ error: 'no_teen_content_to_unlock' }, { status: 404 });
  }

  const { consentId } = await requestTeenContentAccess(database, {
    familyId,
    parentUserId,
    teenChildId,
    actionId: parsed.data.actionId,
  });

  return NextResponse.json({ status: 'requested', consentId }, { status: 202 });
}
