import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { readLogsPage } from '~/lib/companion/logs-page';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';

// Node runtime: readLogsPage uses the Drizzle client.
export const runtime = 'nodejs';

const querySchema = z.object({
  /** Narrow to one child, or omit for the whole family. */
  child: z.string().uuid().optional(),
  /** Keyset cursor from the previous page (occurredAt), or omit for the first page. */
  before: z.string().datetime({ offset: true }).optional(),
});

/**
 * GET /api/companion/logs — a page of the family's quick-logs for the dedicated
 * logs view (filter switch + load-more). Auth is the consent gate (rule #1):
 * dev-preview refuses with 501, signed-out with 401, no-family with 403.
 * Family-scoped + teen-redacted by readLogsPage — it can only ever return THIS
 * family's live (non-deleted) episodes.
 */
export async function GET(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to see your logs' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    child: url.searchParams.get('child') ?? undefined,
    before: url.searchParams.get('before') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const requestingUserId = await resolveUserIdForUser(externalAuthId, database);
  const page = await readLogsPage(database, familyId, requestingUserId, {
    childId: parsed.data.child,
    before: parsed.data.before,
  });

  return NextResponse.json(page);
}
