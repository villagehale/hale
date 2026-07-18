import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { MEASUREMENT_EPISODE, quickLogSchema, resolveMeasurement, resolveOccurredAt } from '~/lib/companion/log-types';
import {
  buildEpisodeInsert,
  childBelongsToFamily,
  resolveFeed,
  resolveNap,
  writeEpisode,
} from '~/lib/companion/log-write';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileLogResponse } from '../../types';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/companion/log — the native quick-log write. Reuses the EXACT
 * lib the web server action (logQuickEpisode) calls: quickLogSchema →
 * resolveOccurredAt → childBelongsToFamily (rule #1, fail closed) →
 * writeEpisode(buildEpisodeInsert(...)). writeEpisode writes the episode row and
 * its immutable audit_log row in one transaction (rule #6), identical to the web
 * path. The web-shell-only revalidatePath is omitted (no server-rendered page to
 * revalidate for a mobile client).
 *
 * Auth() is the consent gate (rule #4): signed-out → 401. An authenticated user
 * with no resolved family (onboarding incomplete) → 403, matching the actions
 * approve/decline routes — never a fabricated family.
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no_database' }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = quickLogSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400 },
    );
  }

  const now = new Date();
  const occurredAt = resolveOccurredAt(parsed.data.occurredAt, now);
  if (!occurredAt.ok) {
    return NextResponse.json({ error: occurredAt.error }, { status: 400 });
  }

  const nap = resolveNap(parsed.data, now);
  if (!nap.ok) {
    return NextResponse.json({ error: nap.error }, { status: 400 });
  }

  const feed = resolveFeed(parsed.data);
  if (!feed.ok) {
    return NextResponse.json({ error: feed.error }, { status: 400 });
  }

  if (parsed.data.kind === MEASUREMENT_EPISODE) {
    const measure = resolveMeasurement(parsed.data.measureKind, parsed.data.value);
    if (!measure.ok) {
      return NextResponse.json({ error: measure.error }, { status: 400 });
    }
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  if (!(await childBelongsToFamily(database, familyId, parsed.data.childId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const authoredBy = await resolveUserIdForUser(session.user.id, database);
  await writeEpisode(
    database,
    buildEpisodeInsert(parsed.data, familyId, occurredAt.date, authoredBy, nap.durationMin),
  );

  const body: MobileLogResponse = { status: 'logged' };
  return NextResponse.json(body, { status: 201 });
}
