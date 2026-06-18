import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { ensureShareToken } from '~/lib/village/share';

/**
 * POST /api/village/share — a parent opts to publicly share this week's plan.
 *
 * Mints (or returns, idempotently) the share token on the family's latest
 * routine proposal and returns the public `/w/:token` link. Auth mirrors the
 * accept route (hard rule #4): auth unconfigured (dev preview) → 501; signed
 * out → 401; no family → 403. The minting writes the audit_log row (rule #6).
 * A family with no week plan yet → 404 (nothing to share).
 */
export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to share a week plan' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
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
