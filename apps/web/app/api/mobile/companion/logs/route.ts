import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { readLogsPage } from '~/lib/companion/logs-page';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileLogsResponse } from '../../types';

// Node runtime: readLogsPage uses the Drizzle client.
export const runtime = 'nodejs';

const querySchema = z.object({
  /** Narrow to one child, or omit for the whole family. */
  child: z.string().uuid().optional(),
  /** Keyset cursor from the previous page (occurredAt), or omit for the first page. */
  before: z.string().datetime({ offset: true }).optional(),
});

/**
 * GET /api/mobile/companion/logs — a keyset-paginated page of the family's
 * quick-logs for the native glance-detail sheet (recent list + naps trend). Wraps
 * the SHARED readLogsPage, so teen redaction (rule #1) comes from that one read
 * path — never a raw select here. The page carries the numerics readLogsPage lifts
 * from payload (durationMin / amountMl / feedKind), numbers only.
 *
 * Auth() is the consent gate (rule #4): signed-out → 401. An authenticated user
 * with no resolved family (onboarding incomplete) → 403, matching the mobile
 * companion/log route — never a fabricated family.
 */
export async function GET(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
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
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const requestingUserId = await resolveUserIdForUser(session.user.id, database);
  const page = await readLogsPage(database, familyId, requestingUserId, {
    childId: parsed.data.child,
    before: parsed.data.before,
  });

  const body: MobileLogsResponse = page;
  return NextResponse.json(body);
}
