import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { ensureActivityShareToken } from '~/lib/village/share';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/village/:id/share — a parent shares ONE village pick as its own
 * public card. Mints (or returns, idempotently) the candidate's share token and
 * returns the public `/a/:token` link. The first mint writes the audit row
 * (rule #6); a child-attributed candidate is refused (rule #1).
 *
 * Auth mirrors the week-plan share route (rule #4): unconfigured → 501; signed
 * out → 401; no family → 403. The lib gates ownership (404/403).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to share a village pick' },
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
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!actorUserId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const result = await ensureActivityShareToken(database, {
    candidateId: idParse.data,
    familyId,
    actorUserId,
  });

  if ('error' in result) {
    const status = result.error === 'candidate_not_found' ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status });
  }

  const base = process.env.APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({ link: `${base}/a/${result.shareToken}` }, { status: 200 });
}
