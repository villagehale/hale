import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { clerkConfigured } from '~/lib/auth-config';
import { resolveFamilyForClerkUser, resolveUserIdForClerkUser } from '~/lib/family';
import { createFamilyInvite } from '~/lib/invites/create';

const bodySchema = z.object({ email: z.string().email().optional() });

/**
 * POST /api/invite — an existing family member mints a co-parent invite link.
 *
 * Auth is the consent surface for rule #5: only an existing member may invite.
 * Clerk unconfigured (dev preview) → 501; configured but not signed in → 401;
 * signed in but not a member of any family → 403. The caller's resolved family
 * IS the membership proof — a member can only ever invite into their own family.
 */
export async function POST(req: Request) {
  if (!clerkConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to create invites' },
      { status: 501 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown = {};
  if (req.headers.get('content-type')?.includes('application/json')) {
    body = await req.json();
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForClerkUser(userId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const creatorUserId = await resolveUserIdForClerkUser(userId, database);
  if (!creatorUserId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const { token } = await createFamilyInvite(database, {
    familyId,
    creatorUserId,
    email: parsed.data.email,
  });

  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({ link: `${base}/invite/${token}` }, { status: 201 });
}
