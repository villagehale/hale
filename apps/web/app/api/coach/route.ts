import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { authConfigured } from '~/lib/auth-config';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { askHale } from '~/lib/coach/agent';

// Node runtime: the agent reads the skill file off disk and calls the Anthropic
// SDK — neither works on the edge runtime.
export const runtime = 'nodejs';

const bodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  /** Continue an existing thread; omitted/null starts a fresh one. */
  conversationId: z.string().uuid().optional(),
  /** The intent chip the parent tapped, if any. */
  intent: z.string().trim().min(1).max(200).optional(),
});

/**
 * POST /api/coach — a signed-in parent asking Ask Hale, now a stateful agent.
 *
 * Auth is the spend gate. When auth is unconfigured (dev preview) we refuse with
 * 501 and NEVER run the agent — no spend, no guessing a family. Signed-out → 401.
 * Family-scoped (rule #1): the agent only ever sees the CALLER's family — its
 * children (teen detail redacted), memory, and conversation thread. The acting
 * parent's user id is the audit actor (rule #6 / PIPEDA right-to-access).
 */
export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to ask Hale' },
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
    return NextResponse.json({ error: 'invalid_question' }, { status: 400 });
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

  const { answer, conversationId } = await askHale(
    {
      familyId,
      question: parsed.data.question,
      intent: parsed.data.intent ?? null,
      conversationId: parsed.data.conversationId ?? null,
      actor: actorUserId,
    },
    database,
  );

  return NextResponse.json({ body: answer, conversationId }, { status: 200 });
}
