import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import { scheduleFamilyDeletion } from '~/lib/rights/delete';

// Node runtime: the scheduler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

// Confirm-gated: this schedules erasure of EVERYTHING Hale holds about the family,
// so the request must carry an explicit confirmation, never a bare POST.
const bodySchema = z.object({ confirm: z.literal(true) });

/**
 * POST /api/mobile/rights/delete — the native "delete my account" (PIPEDA/Law 25
 * right-to-erasure). Delegates to the SAME scheduler the web delete route uses: it
 * does NOT hard-delete, it stamps a reversible 7-day grace date and writes the audit
 * row (rules #1/#6); the worker erases only after the grace lapses. This route only
 * gates + resolves the family, never touches the DB itself. Auth ladder mirrors the
 * other mobile routes: no DB (dev preview) → 503, signed out → 401, no family / no
 * acting user → 403. A request without confirm:true → 400 — nothing is scheduled.
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    currentFamilyId(database),
    resolveUserIdForUser(session.user.id, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const { scheduledDeletionAt } = await scheduleFamilyDeletion(database, {
    familyId,
    actorUserId,
  });

  return NextResponse.json(
    { status: 'scheduled', scheduledDeletionAt: scheduledDeletionAt.toISOString() },
    { status: 202 },
  );
}
