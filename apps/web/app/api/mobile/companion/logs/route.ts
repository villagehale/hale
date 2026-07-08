import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import {
  deleteEpisodeSchema,
  editEpisodeSchema,
  MEASUREMENT_EPISODE,
  resolveOccurredAt,
} from '~/lib/companion/log-types';
import { softDeleteEpisode, updateEpisode } from '~/lib/companion/log-write';
import { readLogsPage } from '~/lib/companion/logs-page';
import { db } from '~/lib/db';
import { currentFamilyId, resolveUserIdForUser } from '~/lib/family';
import type {
  MobileLogDeleteResponse,
  MobileLogEditResponse,
  MobileLogsResponse,
} from '../../types';

// Node runtime: readLogsPage uses the Drizzle client.
export const runtime = 'nodejs';

const querySchema = z.object({
  /** Narrow to one child, or omit for the whole family. */
  child: z.string().uuid().optional(),
  /** Narrow to measurements only (Growth), keeping a rare-event series off the
   * shared page budget so old readings don't fall off the page. Omit for all kinds. */
  episodeType: z.literal(MEASUREMENT_EPISODE).optional(),
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
    episodeType: url.searchParams.get('episodeType') ?? undefined,
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
    episodeType: parsed.data.episodeType,
    before: parsed.data.before,
  });

  const body: MobileLogsResponse = page;
  return NextResponse.json(body);
}

/**
 * Resolves the family AND the acting parent's user id for an audited mutation, or a
 * NextResponse to return when the request can't proceed (401 signed-out, 503 no db,
 * 403 no family). Fails closed — never fabricates a family or actor (rule #1). The
 * mobile counterpart of the web action's resolveWriteScope.
 */
async function resolveMutationScope(): Promise<
  | { ok: true; database: ReturnType<typeof db>; familyId: string; actorUserId: string }
  | { ok: false; response: Response }
> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, response: NextResponse.json({ error: 'no_database' }, { status: 503 }) };
  }

  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    };
  }

  const database = db();
  const familyId = await currentFamilyId(database);
  if (!familyId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'no_family_for_user' }, { status: 403 }),
    };
  }

  // An audited edit/delete needs a real actor (rule #6). A signed-in user with no
  // mirrored users row (onboarding incomplete) can't be the actor → fail closed.
  const actorUserId = await resolveUserIdForUser(session.user.id, database);
  if (!actorUserId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'no_family_for_user' }, { status: 403 }),
    };
  }

  return { ok: true, database, familyId, actorUserId };
}

/**
 * PATCH /api/mobile/companion/logs — the native Diary edit. Reuses the EXACT lib the
 * web editQuickEpisode action calls: editEpisodeSchema → resolveOccurredAt →
 * updateEpisode (summary + occurredAt only). updateEpisode is FAMILY-SCOPED (rule
 * #1): a foreign episode id matches nothing → returns false → 403 here, never a
 * silent success. It writes ONE immutable audit_log row carrying before + after
 * (rule #6). The web-shell-only revalidatePath is dropped (no server-rendered page).
 */
export async function PATCH(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = editEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400 },
    );
  }

  const occurredAt = resolveOccurredAt(parsed.data.occurredAt, new Date());
  if (!occurredAt.ok) {
    return NextResponse.json({ error: occurredAt.error }, { status: 400 });
  }

  const scope = await resolveMutationScope();
  if (!scope.ok) return scope.response;

  const ok = await updateEpisode(
    scope.database,
    parsed.data.id,
    scope.familyId,
    { summary: parsed.data.summary, occurredAt: occurredAt.date },
    scope.actorUserId,
  );
  if (!ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body: MobileLogEditResponse = { status: 'edited' };
  return NextResponse.json(body);
}

/**
 * DELETE /api/mobile/companion/logs — the native Diary soft-delete. Reuses the EXACT
 * lib the web deleteQuickEpisode action calls: deleteEpisodeSchema → softDeleteEpisode,
 * which stamps deleted_at rather than erasing the row (rules #6, #9) and is
 * family-scoped like the edit (a foreign id → false → 403). One audit_log row.
 */
export async function DELETE(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = deleteEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400 },
    );
  }

  const scope = await resolveMutationScope();
  if (!scope.ok) return scope.response;

  const ok = await softDeleteEpisode(
    scope.database,
    parsed.data.id,
    scope.familyId,
    scope.actorUserId,
  );
  if (!ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body: MobileLogDeleteResponse = { status: 'deleted' };
  return NextResponse.json(body);
}
