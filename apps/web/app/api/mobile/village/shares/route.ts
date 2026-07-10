import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { listSharedLinks } from '~/lib/village/share-revoke';
import type { MobileSharedLinksResponse } from '../../types';

// Node runtime: the list read uses the Drizzle client.
export const runtime = 'nodejs';

/**
 * GET /api/mobile/village/shares — the native "links you have shared" list for the
 * signed-in parent's family. Delegates to the SAME family-scoped lib the web route
 * uses (rule #1); read-only, so no audit row. This route only gates + resolves the
 * family, never touches the DB itself. Auth ladder mirrors the other mobile routes:
 * no DB (dev preview) → 503, signed out → 401, no family → 403.
 */
export async function GET(): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const links = await listSharedLinks(database, familyId);
  const body: MobileSharedLinksResponse = { links };
  return NextResponse.json(body);
}
