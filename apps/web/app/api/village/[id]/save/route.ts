import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { toggleVillageSave } from '~/lib/village/save';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/village/:id/save — a parent privately saves ("I'm interested") a
 * village candidate, or unsaves it (this is a TOGGLE). A save is PRIVATE and
 * low-commitment: it neither enrolls the child nor sends anything for approval
 * (that is Accept), and it is never surfaced to anyone but the saving family
 * (unlike an Endorse count). Both directions write an immutable audit_log row
 * (rule #6); the response carries the resulting `saved` boolean.
 *
 * Auth mirrors the endorse route (rule #4): unconfigured (dev preview) → 501;
 * signed out → 401; no family → 403. Save is gated to the candidate's own family
 * server-side (404/403 from the lib). A teen-attributed candidate can never be NEWLY
 * saved from any surface — the lib age-gates it deterministically (403
 * candidate_teen_redacted), so a direct POST can't create a teen save the UI hides
 * (rule #1); an existing save may still be removed (never stuck).
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to save a village candidate' },
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

  const result = await toggleVillageSave(database, {
    candidateId: idParse.data,
    familyId,
    userId,
  });

  if (result.status === 200) {
    return NextResponse.json({ saved: result.saved }, { status: 200 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
