import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import { assembleFamilyExport } from '~/lib/rights/export';

// Node runtime: the assembler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

/**
 * GET /api/mobile/rights/export — the native "download a copy" (PIPEDA/Law 25
 * right-to-access + portability). Delegates to the SAME assembler the web export
 * route uses, so the lib owns the teen redaction and the immutable audit_log row
 * (rules #1/#6); this route only gates + resolves the family, never touches the DB
 * itself. Mobile shares the JSON via the RN Share sheet, so no content-disposition
 * is set. Auth ladder mirrors the other mobile routes: no DB (dev preview) → 503,
 * signed out → 401, no family / no acting user → 403.
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
  const [familyId, actorUserId] = await Promise.all([
    currentFamilyId(database),
    resolveUserIdForUser(session.user.id, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const document = await assembleFamilyExport(database, familyId, { actorUserId });
  return NextResponse.json(document);
}
