import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { revokeShareLink } from '~/lib/village/share-revoke';

// Node runtime: the revoke mutation uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

const bodySchema = z.object({
  kind: z.enum(['week_plan', 'activity']),
  id: z.string().uuid(),
});

/**
 * POST /api/village/shares/revoke — a parent turns off one shared link. Nulls the
 * token (the public page then fails closed) and writes the audit row (rule #6),
 * family-scoped (rule #1). Auth mirrors the share route: dev preview → 501, signed
 * out → 401, no family/user → 403. A malformed body → 400. A link the family doesn't
 * own (or already revoked) → 404 — no write.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to manage your shared links' },
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
    return NextResponse.json({ error: 'invalid_link' }, { status: 400 });
  }

  const database = db();
  const [familyId, actorUserId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
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

  return NextResponse.json({ status: 'revoked' }, { status: 200 });
}
