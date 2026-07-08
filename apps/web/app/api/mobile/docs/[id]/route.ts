import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { softDeleteDocument } from '~/lib/docs/documents';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileDocDeleteResponse } from '../../types';

// Node runtime: the soft-delete lib uses the Drizzle client + storage removal.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * DELETE /api/mobile/docs/:id — soft-delete a document. FAMILY-SCOPED (rule #1):
 * softDeleteDocument matches only a live row within the family, so a foreign /
 * already-removed id matches nothing → false → 404, writing nothing. A matched
 * delete stamps deleted_at (the row stays for the audit trail, rules #6/#9), removes
 * the bytes from the private bucket, and writes ONE immutable audit_log row (doc id +
 * kind only). softDeleteDocument re-applies the teen read gate (rule #1): a redacted
 * doc 404s exactly like a foreign one — the teen set derives live from DOB, so an id
 * cached before a child turned 13 confirms nothing and deletes nothing.
 *
 * Auth() is the consent gate (rule #4): signed-out → 401; no resolved family → 403.
 */
export async function DELETE(_req: Request, context: RouteContext): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
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

  const actorUserId = await resolveUserIdForUser(session.user.id, database);
  if (!actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const ok = await softDeleteDocument(database, id, familyId, actorUserId);
  if (!ok) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body: MobileDocDeleteResponse = { status: 'deleted' };
  return NextResponse.json(body);
}
