import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { getQueue } from '~/lib/queue';
import { clerkConfigured } from '~/lib/auth-config';
import { resolveFamilyForClerkUser } from '~/lib/family';
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
 * never enqueue a family's signal. Clerk unconfigured (dev preview) → 501;
 * configured but not signed in → 401; signed in but no family → 403. Only a
 * signed-in parent whose family owns the candidate gets it enqueued (202).
 */
export async function POST(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const idParse = idSchema.safeParse(id);
  if (!idParse.success) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  if (!clerkConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'auth required to accept village candidates' },
      { status: 501 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const database = db();
  const familyId = await resolveFamilyForClerkUser(userId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }

  const queue = await getQueue();
  const result = await acceptVillageCandidate(database, queue, {
    candidateId: idParse.data,
    familyId,
  });

  if (result.status === 202) {
    return NextResponse.json({ status: 'accepted', payload: result.payload }, { status: 202 });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
