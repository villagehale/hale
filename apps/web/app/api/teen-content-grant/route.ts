import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { requestTeenAccessGrant, resolveActionTeenChild } from '~/lib/teen-access';

// Node runtime: the grant writer uses the Drizzle client + a transaction.
export const runtime = 'nodejs';

const bodySchema = z.object({
  /** The redacted approval row the parent wants to unlock. */
  actionId: z.string().uuid(),
  /**
   * Why they want to read it. Required — "explicit" (rule #1) means the parent said
   * so in their own words, and the teen is shown this reason with the assent ask.
   */
  reason: z.string().trim().min(3).max(500),
});

/**
 * POST /api/teen-content-grant — a parent REQUESTS time-limited access to a 13+
 * teen's redacted approval content (rule #1 named exception). This does NOT reveal
 * anything and does NOT unlock anything: it records an explicit, audited (rule #6),
 * scope-bound grant in its REQUESTED state — no activation window — and notifies the
 * teen. Only the teen's assent activates it (rule #5); until then every read still
 * redacts. The scope is always `message_content`: an approval row's drafted payload
 * is the observed content, and a request must never widen itself.
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
  const [familyId, parentUserId, requestHeaders] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
    headers(),
  ]);
  if (!familyId || !parentUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  // Every request notifies the TEEN, so an unbounded endpoint is a way to pester a
  // child. Fail-closed (rule #1): a limiter outage must not remove that guard.
  const limited = await enforceRateLimit('teen-content-grant', parentUserId, true);
  if (limited) return limited;

  const teenChildId = await resolveActionTeenChild(database, familyId, parsed.data.actionId);
  if (!teenChildId) {
    return NextResponse.json({ error: 'no_teen_content_to_unlock' }, { status: 404 });
  }

  const { grantId } = await requestTeenAccessGrant(database, {
    familyId,
    parentUserId,
    teenChildId,
    scope: 'message_content',
    reason: parsed.data.reason,
    ip: requestHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
  });

  return NextResponse.json({ status: 'requested', grantId }, { status: 202 });
}
