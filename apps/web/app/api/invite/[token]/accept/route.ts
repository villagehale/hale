import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { ensureUserRow } from '~/lib/family';
import { acceptFamilyInvite } from '~/lib/invites/accept';

interface RouteContext {
  params: Promise<{ token: string }>;
}

/**
 * POST /api/invite/:token/accept — a signed-in invitee redeems an invite to join
 * the inviter's family as a co_parent. Auth unconfigured (dev preview) → 501;
 * configured but not signed in → 401. A first-time invitee has no mirrored
 * `users` row yet, so we provision one (ensureUserRow) before redeeming — the
 * invitee joins the EXISTING family, never a new one. A genuine new membership
 * writes an audit_log row (rule #6) inside acceptFamilyInvite. A targeted invite
 * (one minted for a specific email) may be redeemed only by that email — a
 * mismatch maps to 403 and writes nothing. Expired/unknown/already-claimed map
 * to distinct 4xx so the invitee sees an honest reason — never a silent failure.
 */
export async function POST(_req: Request, context: RouteContext) {
  const { token } = await context.params;

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to accept invites' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const email = session.user?.email;
  if (!email) {
    return NextResponse.json({ error: 'no_email_for_caller' }, { status: 403 });
  }

  const database = db();
  const internalUserId = await ensureUserRow(
    { externalAuthId, email, name: session.user?.name ?? null },
    database,
  );

  const result = await acceptFamilyInvite(database, { token, userId: internalUserId, email });

  switch (result.status) {
    case 'accepted':
      return NextResponse.json({ status: 'accepted', familyId: result.familyId }, { status: 200 });
    case 'not_found':
      return NextResponse.json({ error: 'invite_not_found' }, { status: 404 });
    case 'expired':
      return NextResponse.json({ error: 'invite_expired' }, { status: 410 });
    case 'already_accepted':
      return NextResponse.json({ error: 'invite_already_accepted' }, { status: 409 });
    case 'wrong_recipient':
      return NextResponse.json({ error: 'invite_wrong_recipient' }, { status: 403 });
  }
}
