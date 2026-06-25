import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { db } from '~/lib/db';
import { getQueue } from '~/lib/queue';
import { authConfigured } from '~/lib/auth-config';
import { resolveFamilyForUser } from '~/lib/family';
import { kickDrain } from '~/lib/cron/kick-drain';
import { acceptVillageCandidate } from '~/lib/village/accept';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.string().uuid();

/**
 * POST /api/village/:id/accept — a parent accepting a discovered village
 * candidate. This does NOT execute anything: it enqueues an events.ingested job
 * carrying the activity so the EXISTING pipeline drafts → reviews → routes it to
 * drafted_for_approval, which the parent then finishes via the existing
 * /api/actions/:id/approve. Keeping the spine intact means every downstream gate
 * (reviewer tool coverage, spending caps, teen-redaction cap) still applies.
 *
 * Auth mirrors the approve route (hard rule #4): an unauthenticated caller may
 * never enqueue a family's signal. Auth unconfigured (dev preview) → 501;
 * configured but not signed in → 401; signed in but no family → 403. Only a
 * signed-in parent whose family owns the candidate gets it enqueued (202).
 */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to accept village candidates' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const queue = await getQueue();
  const result = await acceptVillageCandidate(database, queue, {
    candidateId: idParse.data,
    familyId,
  });

  if (result.status === 202) {
    // Kick the drain so the accepted item flows through the pipeline now rather
    // than waiting up to 60s for the next cron tick (the cron is the safety net).
    const origin = process.env.APP_URL ?? new URL(req.url).origin;
    after(() => kickDrain(origin));
    return NextResponse.json({ status: 'accepted', payload: result.payload }, { status: 202 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
