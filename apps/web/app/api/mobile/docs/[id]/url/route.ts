import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import {
  documentVisibleToRequester,
  loadOwnedDocument,
  signAndAuditDocument,
} from '~/lib/docs/documents';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileDocUrlResponse } from '../../../types';

// Node runtime: mints the signed URL through the Drizzle-backed docs lib.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * GET /api/mobile/docs/:id/url — a short-TTL signed URL for viewing one document.
 * FAMILY-SCOPED (loadOwnedDocument returns null for a foreign / removed doc → 404)
 * and TEEN-GATED (rule #1): a 13+ child's doc is visible ONLY to its uploader, so a
 * requester who fails documentVisibleToRequester gets a 404 — a signed URL is NEVER
 * minted for a redacted doc, matching the list. A minted URL writes its immutable
 * view-url audit row (doc id + kind only, rule #6) inside signAndAuditDocument.
 *
 * Auth() is the consent gate (rule #4): signed-out → 401; no resolved family → 403.
 */
export async function GET(_req: Request, context: RouteContext): Promise<Response> {
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

  const requestingUserId = await resolveUserIdForUser(session.user.id, database);
  if (!requestingUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const doc = await loadOwnedDocument(database, id, familyId);
  // A foreign / removed doc and a teen-redacted doc are indistinguishable to the
  // caller — both 404 (rule #1: never reveal a redacted doc exists).
  if (!doc || !(await documentVisibleToRequester(database, familyId, doc, requestingUserId))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = await signAndAuditDocument(database, familyId, requestingUserId, doc);

  const body: MobileDocUrlResponse = { url };
  return NextResponse.json(body);
}
