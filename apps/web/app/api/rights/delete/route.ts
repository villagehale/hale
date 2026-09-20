import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { listSeatsForUser, resolveUserIdForUser } from '~/lib/family';
import { tellStayingParent } from '~/lib/channel/coparent/departure-notice';
import { departureNoticePorts } from '~/lib/channel/twilio/deps';
import { requestErasure } from '~/lib/rights/delete';

// Node runtime: the scheduler uses the Drizzle client and writes the audit row.
export const runtime = 'nodejs';

// Confirm-gated: this removes EVERYTHING Hale holds about the family, so the
// request must carry an explicit confirmation, never a bare POST.
const bodySchema = z.object({ confirm: z.literal(true) });

/**
 * POST /api/rights/delete — a parent requests deletion of their account/family
 * (PIPEDA/Law 25 right-to-erasure). This does NOT hard-delete: the scheduler
 * stamps a grace-period deletion date and writes the audit row (rule #6); the
 * worker erases the family only after the grace lapses (reversible until then).
 * Auth mirrors the share route (rule #1): dev-preview 501, signed out 401, no
 * family / no user 403. A request without confirm:true is 400 — nothing is scheduled.
 *
 * WHOSE erasure this is depends on the caller's seat, and `requestErasure` decides it
 * (VIL-355): a co-parent is departed on their own and answered `departed` with the tally
 * of what was undone, so the response can never let them believe the household's record
 * went with them; the primary parent gets the scheduled family, unchanged; any scoped
 * seat is refused 403.
 *
 * WHICH household it is, this route decides, and it refuses to guess. The seats are
 * enumerated rather than resolved through `resolveFamilyForUser`, whose `limit(1)` has
 * no ORDER BY: a separated parent holds two, and letting heap order choose between
 * scheduling their own children's deletion and departing the other family is not a
 * choice an irreversible door may make on their behalf. Two seats → 409, and the person
 * is asked which one they meant.
 */
export async function POST(req: Request): Promise<Response> {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to delete your account' },
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
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }

  const database = db();
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  const seats = actorUserId ? await listSeatsForUser(actorUserId, database) : [];
  if (!actorUserId || seats.length === 0) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  if (seats.length > 1) {
    return NextResponse.json({ error: 'multiple_families' }, { status: 409 });
  }
  const familyId = seats[0]?.familyId as string;

  const result = await requestErasure(database, { familyId, actorUserId });

  if (result.outcome === 'not_permitted') {
    return NextResponse.json({ error: 'not_permitted' }, { status: 403 });
  }

  if (result.outcome === 'co_parent_departed') {
    // THE PARENT WHO STAYED IS TOLD, once (VIL-355 follow-up). After the transaction,
    // never inside it: the departure's correctness is that it is all-or-nothing, and a
    // network round trip has no business inside that.
    //
    // Its outcome is LOGGED and never returned. The person reading this response is the
    // one who left, and "not_enrolled" or "quiet_hours" about the other parent is that
    // parent's channel state, which is not theirs to be told (rule #1). The absence is
    // named where it belongs: the suppressed `channel_messages` receipt and this line.
    //
    // Caught at the controller boundary, which is the one place rule #8 allows it: the
    // erasure has already COMMITTED, so a 500 here would tell somebody their request
    // failed when it did not — and their retry would be refused, the seat being gone.
    let notice: string;
    try {
      notice = await tellStayingParent(
        database,
        { familyId, departedUserId: actorUserId, now: new Date() },
        departureNoticePorts(database),
      );
    } catch (err) {
      notice = 'notice_failed';
      console.error(
        { familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
        'rights/delete: the co-parent departed but the staying parent could not be told',
      );
    }
    console.info({ familyId, notice }, 'rights/delete: co-parent departed');
    // The WHOLE tally, not the revocations alone: what ended and what was deliberately
    // kept both reach the person who asked to be erased (rule #11).
    const { outcome: _outcome, ...tally } = result.departure;
    return NextResponse.json({ status: 'departed', ...tally }, { status: 202 });
  }

  return NextResponse.json(
    { status: 'scheduled', scheduledDeletionAt: result.scheduledDeletionAt.toISOString() },
    { status: 202 },
  );
}
