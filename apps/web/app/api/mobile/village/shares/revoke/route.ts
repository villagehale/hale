import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import { revokeShareLink } from '~/lib/village/share-revoke';

// Node runtime: the revoke mutation uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

const bodySchema = z.object({
  kind: z.enum(['week_plan', 'activity']),
  id: z.string().uuid(),
});

/**
 * POST /api/mobile/village/shares/revoke — the native "turn off one shared link".
 * Delegates to the SAME lib the web route uses: it nulls the token (the public page
 * then fails closed) and writes the audit row, family-scoped (rules #1/#6). This
 * route only gates + resolves the family, never touches the DB itself. Auth ladder
 * mirrors the other mobile routes: no DB (dev preview) → 503, signed out → 401, no
 * family / no acting user → 403. A malformed body → 400; a link the family doesn't
 * own (or already revoked) → 404 — no write.
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
    return NextResponse.json({ error: 'invalid_link' }, { status: 400 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    currentFamilyId(database),
    resolveUserIdForUser(session.user.id, database),
  ]);
  if (!familyId || !actorUserId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const revoked = await revokeShareLink(database, {
    kind: parsed.data.kind,
    id: parsed.data.id,
    familyId,
    actorUserId,
  });
  if (!revoked) {
    return NextResponse.json({ error: 'link_not_found' }, { status: 404 });
  }

  return NextResponse.json({ status: 'revoked' });
}
