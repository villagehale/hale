import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@hale/db';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { authConfigured } from '~/lib/auth-config';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { actionTypeForIntent } from '~/lib/coach/action-intent';
import { draftInlineAction } from '~/lib/coach/inline-action';

// Node runtime: the inline-action engine uses node:crypto + the Drizzle client.
export const runtime = 'nodejs';

const bodySchema = z.object({
  /** The detected action intent kind (validated against the closed set server-side). */
  intentKind: z.string().trim().min(1).max(64),
  /** The child the conversation was focused on, if any. */
  focusedChildId: z.string().uuid().optional(),
  /** The answer text that implied the action — carried as the draft's rationale. */
  sourceAnswer: z.string().trim().min(1).max(4000),
});

/**
 * POST /api/coach/action — a parent tapping a gated action chip in Ask Hale.
 *
 * This NEVER executes (rule #4): it routes the intent through the existing approval
 * engine, producing a draft HELD at drafted_for_approval that the parent must
 * approve on the Approvals surface. Auth is the consent gate — dev preview refuses
 * with 501, signed-out with 401. Family-scoped (rule #1): the focused child must
 * belong to the caller's family or it is dropped to null (no cross-family leak).
 * The acting parent is the audit actor (rule #6).
 */
export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to act with Hale' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Reject an unknown intent before touching the DB — a client can't ask the engine
  // to draft an arbitrary action type.
  if (!actionTypeForIntent(parsed.data.intentKind)) {
    return NextResponse.json({ error: 'unknown_intent' }, { status: 400 });
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

  const childId = parsed.data.focusedChildId
    ? await resolveFamilyChild(database, parsed.data.focusedChildId, familyId)
    : null;

  const { actionId } = await draftInlineAction(
    {
      familyId,
      actor: actorUserId,
      intentKind: parsed.data.intentKind,
      childId,
      sourceAnswer: parsed.data.sourceAnswer,
    },
    database,
  );

  return NextResponse.json({ status: 'drafted_for_approval', actionId }, { status: 202 });
}

/** Returns the child id iff it names a real child of THIS family, else null (rule #1). */
async function resolveFamilyChild(
  database: ReturnType<typeof db>,
  childId: string,
  familyId: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  return rows[0]?.id ?? null;
}
