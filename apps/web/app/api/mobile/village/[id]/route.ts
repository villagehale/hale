import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { loadVillageCandidateById } from '~/lib/village/queries';
import type { MobileVillageCandidateResponse } from '../../types';

export const runtime = 'nodejs';

const idSchema = z.string().uuid();

/**
 * GET /api/mobile/village/:id — one discovered candidate for the native pushed
 * Activity route (the sheet→stack conversion). FAMILY-SCOPED and TEEN-REDACTED at
 * the shared mapper inside loadVillageCandidateById (rule #1): a 13+ child's card
 * returns the locked view (category only), and an unknown or foreign id returns
 * `{ candidate: null }` — indistinguishable, so the route lands on its calm empty
 * state without ever revealing that a redacted card exists. Auth() is the 401 gate;
 * this route never touches the DB directly (the loader does, behind currentFamilyId).
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const candidate = await loadVillageCandidateById(id);
  const body: MobileVillageCandidateResponse = { candidate };
  return NextResponse.json(body);
}
