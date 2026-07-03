import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { assembleFamilyExport } from '~/lib/rights/export';

// Node runtime: the assembler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

/**
 * GET /api/rights/export — a parent downloads everything Hale holds about their
 * family (PIPEDA/Law 25 right-to-access + portability). Auth mirrors the share
 * route (rule #1): dev-preview → 501; signed out → 401; no family / no user → 403.
 * The assembler writes the immutable audit_log row (rule #6) and applies the same
 * teen redaction the app already shows — the requesting parent gets exactly what
 * they can already see, never raw teen content.
 */
export async function GET(_req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to export your data' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const document = await assembleFamilyExport(database, familyId, { actorUserId });

  const filename = `hale-export-${document.exportedAt.slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
