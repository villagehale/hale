import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { reverseExecutedCalendarAction } from '~/lib/actions/reverse-calendar';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';

// Node runtime: the reversal runs a Drizzle transaction.
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/actions/:id/undo — a parent taking back a calendar placement Hale made.
 *
 * Delegates to `reverseExecutedCalendarAction`, the SAME primitive the SMS "undo"
 * command is wired to (channel/router/wiring.ts), so a tap and a text cannot diverge
 * on which actions are reversible, on the 24h window, or on the audit rows written.
 * That primitive owns every gate; this route adds only auth, and passes its refusal
 * through verbatim rather than reinterpreting it.
 *
 * Gated identically to approve/decline: auth unconfigured (dev preview) → 501,
 * signed-out → 401, a family that doesn't own the action → 403. The audit actor is
 * the INTERNAL users.id — family_members.user_id holds that id, so an external
 * Auth.js id would credit the parent's own reversal to Hale (rules #5, #6).
 *
 * Reachable from the native app through the Edge Bearer bridge, exactly like
 * /api/actions/:id/approve — so there is no separate mobile route.
 */
export async function POST(_req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_action_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to undo actions' },
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
  const revertedBy = await resolveUserIdForUser(externalAuthId, database);
  if (!revertedBy) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  const result = await reverseExecutedCalendarAction(database, {
    actionId: idParse.data,
    familyId,
    revertedBy,
  });

  if (result.status === 200) {
    return NextResponse.json({ status: 'undone' }, { status: 200 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
