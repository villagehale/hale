import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { eraseConversation, softDeleteMessage } from '~/lib/coach/conversation-delete';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';

// Node runtime: the mutation uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

// Exactly ONE target: a single turn (messageId) or the whole conversation
// (conversationId). A discriminated union so a body with neither/both is rejected.
const bodySchema = z.union([
  z.object({ messageId: z.string().uuid() }),
  z.object({ conversationId: z.string().uuid() }),
]);

/**
 * POST /api/coach/delete — a parent removes their own Concierge history: one turn
 * (`messageId`) or the whole conversation (`conversationId`). Both are SOFT deletes
 * (stamp deleted_at) so the audit row survives (rule #6). Auth mirrors the coach
 * route (rule #1): dev preview → 501, signed out → 401, no family/user → 403. The
 * mutation is family-scoped — a target the caller's family doesn't own → 404 (never
 * a cross-family write). A malformed body → 400.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to manage your conversation' },
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
    return NextResponse.json({ error: 'invalid_target' }, { status: 400 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  if ('messageId' in parsed.data) {
    const deleted = await softDeleteMessage(database, {
      messageId: parsed.data.messageId,
      familyId,
      actorUserId,
    });
    if (!deleted) {
      return NextResponse.json({ error: 'turn_not_found' }, { status: 404 });
    }
    return NextResponse.json({ status: 'deleted' }, { status: 200 });
  }

  const erased = await eraseConversation(database, {
    conversationId: parsed.data.conversationId,
    familyId,
    actorUserId,
  });
  if (erased === null) {
    return NextResponse.json({ error: 'conversation_not_found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'erased', erasedTurns: erased }, { status: 200 });
}
