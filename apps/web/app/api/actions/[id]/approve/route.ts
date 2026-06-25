import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { getQueue } from '~/lib/queue';
import { authConfigured } from '~/lib/auth-config';
import { resolveFamilyForUser } from '~/lib/family';
import { kickDrain } from '~/lib/cron/kick-drain';
import { approveDraftedAction } from '~/lib/actions/approve';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/actions/:id/approve — a parent approving a drafted action.
 *
 * Auth is the consent surface for hard rule #4: an unauthenticated caller may
 * NEVER execute a real action. So when auth is unconfigured (dev preview) we
 * refuse with 501 rather than guessing a family; when it's configured but the
 * caller isn't signed in we return 401. Only a signed-in parent whose family
 * owns the drafted action gets it enqueued (202).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_action_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to approve actions' },
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

  const queue = await getQueue();
  const result = await approveDraftedAction(database, queue, {
    actionId: idParse.data,
    familyId,
    approvedBy: externalAuthId,
  });

  if (result.status === 202) {
    // Kick the drain so the approved action executes now rather than waiting up
    // to 60s for the next cron tick (the cron is the safety net).
    const origin = process.env.APP_URL ?? new URL(req.url).origin;
    after(() => kickDrain(origin));
    return NextResponse.json({ status: 'approved', payload: result.payload }, { status: 202 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
