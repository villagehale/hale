import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { clerkConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForClerkUser, resolveUserIdForClerkUser } from '~/lib/family';
import { ensureShareToken } from '~/lib/village/share';

/**
 * POST /api/village/share — a parent opts to publicly share this week's plan.
 *
 * Mints (or returns, idempotently) the share token on the family's latest
 * routine proposal and returns the public `/w/:token` link. Auth mirrors the
 * accept route (hard rule #4): Clerk unconfigured (dev preview) → 501; signed
 * out → 401; no family → 403. The minting writes the audit_log row (rule #6).
 * A family with no week plan yet → 404 (nothing to share).
 */
export async function POST(req: Request) {
  if (!clerkConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to share a week plan' },
      { status: 501 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await resolveFamilyForClerkUser(userId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const actorUserId = await resolveUserIdForClerkUser(userId, database);
  if (!actorUserId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const result = await ensureShareToken(database, { familyId, actorUserId });
  if (!result) {
    return NextResponse.json({ error: 'no_week_plan_to_share' }, { status: 404 });
  }

  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({ link: `${base}/w/${result.shareToken}` }, { status: 200 });
}
