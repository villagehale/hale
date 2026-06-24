import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { ensureShareToken } from '~/lib/village/share';

/**
 * POST /api/village/picks/share — a parent shares their endorsed "village picks"
 * shortlist. The picks artifact (`/picks/:token`) is keyed on the SAME
 * routine_proposals share token as `/w` (one token per family's plan), so this
 * reuses `ensureShareToken` (idempotent, audited at rule #6) and just builds the
 * picks link. Reusing the token means a parent's plan link and picks link share
 * one stable, revocable handle.
 *
 * Auth mirrors the week-plan share route (rule #4): unconfigured → 501; signed
 * out → 401; no family → 403; no plan to anchor a token → 404.
 */
export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to share your picks' },
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
    return NextResponse.json({ error: 'no_plan_to_anchor_picks' }, { status: 404 });
  }

  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({ link: `${base}/picks/${result.shareToken}` }, { status: 200 });
}
