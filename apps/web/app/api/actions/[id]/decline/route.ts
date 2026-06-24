import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { authConfigured } from '~/lib/auth-config';
import { resolveFamilyForUser } from '~/lib/family';
import { declineDraftedAction } from '~/lib/actions/decline';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/actions/:id/decline — a parent dismissing a drafted action (the "no"
 * of the consent queue, rule #4). Declining is still a write — it transitions the
 * action and records an audit row — so it is gated identically to approve: auth
 * unconfigured (dev preview) → 501, signed-out → 401, a family that doesn't own
 * the draft → 403. Only a signed-in parent whose family owns the draft dismisses
 * it (200). No queue send — a declined draft is never handed to the worker.
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_action_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to decline actions' },
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

  const result = await declineDraftedAction(database, {
    actionId: idParse.data,
    familyId,
    declinedBy: externalAuthId,
  });

  if (result.status === 200) {
    return NextResponse.json({ status: 'declined' }, { status: 200 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
