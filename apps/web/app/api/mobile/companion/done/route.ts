import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { markDoneSchema } from '~/lib/companion/log-types';
import { buildDoneEpisodeInsert, childBelongsToFamily, writeEpisode } from '~/lib/companion/log-write';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type { MobileDoneResponse } from '../../types';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/companion/done — the native "mark done" for a curated companion
 * item (a milestone or a health checkup). Reuses the EXACT lib the web
 * markCompanionItemDone server action calls: markDoneSchema → childBelongsToFamily
 * (rule #1, fail closed) → writeEpisode(buildDoneEpisodeInsert(...)). writeEpisode
 * writes the episode row and its immutable audit_log row in one transaction (rule
 * #6), identical to the web path — a milestone-done writes the SAME row a quick-log
 * milestone writes; a health-done writes a 'health_done' episode carrying the key.
 * The web-shell-only revalidatePath is omitted (no server-rendered page here). The
 * time is server-clocked — a done-tap records "confirmed done today", not a
 * backdate.
 *
 * Auth() is the consent gate (rule #4): signed-out → 401; an authenticated user
 * with no resolved family → 403, matching the log route — never a fabricated family.
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
  const parsed = markDoneSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400 },
    );
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
    buildDoneEpisodeInsert(parsed.data, familyId, new Date(), authoredBy),
  );

  const body: MobileDoneResponse = { status: 'done' };
  return NextResponse.json(body, { status: 201 });
}
