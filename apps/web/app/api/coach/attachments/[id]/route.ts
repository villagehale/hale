import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { loadOwnedAttachment, signAndAuditAttachment } from '~/lib/coach/attachments';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';

// Node runtime: mints the signed URL through the Drizzle-backed attachments lib.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * GET /api/coach/attachments/:id — a short-TTL signed URL (600s) for viewing one
 * attachment. Shared web-cookie + mobile-Bearer auth, resolved like /api/coach.
 * FAMILY-SCOPED (rule #1): loadOwnedAttachment returns null for a foreign / unknown
 * id → 404 (indistinguishable). A minted URL writes its immutable view-url audit row
 * (attachment id only) inside signAndAuditAttachment (rule #6).
 */
export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'auth_required' }, { status: 501 });
  }

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
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
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!actorUserId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const attachment = await loadOwnedAttachment(database, id, familyId);
  if (!attachment) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const url = await signAndAuditAttachment(database, familyId, actorUserId, attachment);
  return NextResponse.json({ url });
}
