import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { endorseVillageCandidate } from '~/lib/village/endorse';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/village/:id/endorse — a parent endorses a village candidate (the
 * trusted-parent half of hybrid trust). Idempotent: re-tapping is a no-op. The
 * first endorsement writes an immutable audit_log row (rule #6) and the response
 * carries the fresh aggregate count so the UI can reflect it.
 *
 * Auth mirrors the accept route (rule #4): unconfigured (dev preview) → 501;
 * signed out → 401; no family → 403. Endorse is gated to the candidate's own
 * family server-side (404/403 from the lib).
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to endorse a village candidate' },
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
  const userId = await resolveUserIdForUser(externalAuthId, database);
  if (!userId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const result = await endorseVillageCandidate(database, {
    candidateId: idParse.data,
    familyId,
    userId,
  });

  if (result.status === 200) {
    // A new endorsement changes the trust signal the ranker weighs — invalidate
    // the family's cached feed order so the next load re-ranks with it.
    if (!result.alreadyEndorsed) {
      revalidateTag(`village-feed:${familyId}`);
    }
    return NextResponse.json(
      { count: result.count, alreadyEndorsed: result.alreadyEndorsed },
      { status: 200 },
    );
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
