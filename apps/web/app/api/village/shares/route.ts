import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { listSharedLinks } from '~/lib/village/share-revoke';

// Node runtime: the list read uses the Drizzle client.
export const runtime = 'nodejs';

/**
 * GET /api/village/shares — the "links you have shared" list for the signed-in
 * parent's family. Family-scoped (rule #1): only the caller's own live links are
 * returned. Auth mirrors the share route: dev preview → 501, signed out → 401, no
 * family → 403. Read-only, so no audit row.
 */
export async function GET(): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to see your shared links' },
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

  const links = await listSharedLinks(database, familyId);
  return NextResponse.json({ links }, { status: 200 });
}
