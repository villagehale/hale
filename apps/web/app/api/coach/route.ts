import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { clerkConfigured } from '~/lib/auth-config';
import { resolveFamilyForClerkUser } from '~/lib/family';
import { askCoach } from '~/lib/coach/coach';
import { loadFamilyStages } from '~/lib/coach/family-stages';
import { recordCoachRun } from '~/lib/coach/record-run';
import { toCoachAnswerView } from '~/lib/coach/view';

// Node runtime: the coach reads the worker's prompt file off disk and calls the
// Anthropic SDK — neither works on the edge runtime.
export const runtime = 'nodejs';

const bodySchema = z.object({ question: z.string().trim().min(1).max(2000) });

/**
 * POST /api/coach — a signed-in parent asking the interactive coach a question.
 *
 * Auth is the spend gate. When Clerk is unconfigured (dev preview) we refuse with
 * 501 and NEVER call the model — no spend, no guessing a family (mirrors the
 * approve route). Signed-out → 401. The coach is family-scoped: it only ever sees
 * the CALLER's family's derived stages (rule #1 — no other family's data, and no
 * raw child content; stage is the only child-derived signal).
 */
export async function POST(req: Request) {
  if (!clerkConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to ask the coach' },
      { status: 501 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_question' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForClerkUser(userId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const stages = await loadFamilyStages(familyId, database);
  const { answer, metrics } = await askCoach({
    question: parsed.data.question,
    // No children rows yet → no stage signal; the coach prompt handles an empty
    // stage list (it asks for what it's missing rather than guessing).
    stages,
  });
  await recordCoachRun(familyId, metrics, database);

  return NextResponse.json(toCoachAnswerView(answer), { status: 200 });
}
