import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { createInviteForSession } from '~/lib/invites/session';

export const runtime = 'nodejs';

const bodySchema = z.object({ email: z.string().email().optional() });

/**
 * POST /api/mobile/invite — the native Family tab's "Invite family member": an
 * existing member mints a co-parent invite link. The web twin of /api/invite at the
 * /api/mobile/* path; the app calls it Bearer-authed and the Edge middleware bridges
 * the token to the same Auth.js session `auth()` reads. All DB access lives behind
 * createInviteForSession (rule #1: mobile routes never touch the DB directly), which
 * reuses the SAME createFamilyInvite lib the web route uses — so the rule-#5 consent
 * (only a member invites, role co_parent) and the rule-#6 audit write are
 * single-sourced, never reimplemented here.
 *
 * Auth is the consent surface: unconfigured (dev preview) → 501; configured but not
 * signed in → 401; signed in but not a member of any family → 403. Returns the
 * absolute redeem URL (the invite is redeemed web-side).
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to create invites' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown = {};
  if (req.headers.get('content-type')?.includes('application/json')) {
    body = await req.json().catch(() => ({}));
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const result = await createInviteForSession(externalAuthId, parsed.data.email);
  if (result.status === 'no_family') {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  if (result.status === 'no_user') {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({ link: `${base}/invite/${result.token}` }, { status: 201 });
}
