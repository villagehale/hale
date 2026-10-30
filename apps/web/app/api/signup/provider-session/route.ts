import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { captureProviderSession } from '~/lib/signup/session-capture';

export const runtime = 'nodejs';

const bodySchema = z.object({
  providerHost: z.string().min(1).max(253),
  storageState: z.unknown(),
});

/**
 * POST /api/signup/provider-session — store a parent's logged-in provider
 * session (VIL-470). Auth is the consent surface: no session, no capture.
 * The vault refuses a password-named cookie or key. Production caller of
 * `captureProviderSession`.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to save a provider sign-in' },
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
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  const parentUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!familyId || !parentUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const result = await captureProviderSession(database, {
    familyId,
    parentUserId,
    providerHost: parsed.data.providerHost,
    storageState: parsed.data.storageState,
    capturedAt: new Date(),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json(
    { ok: true, id: result.id, expiresAt: result.expiresAt.toISOString() },
    { status: 200 },
  );
}
