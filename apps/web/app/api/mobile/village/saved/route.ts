import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadSavedVillageCandidates } from '~/lib/village/queries';
import type { MobileSavedResponse } from '../../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/village/saved — the More → Saved screen: the family's privately
 * saved candidates ("I'm interested"), newest first. Teen redaction lives inside
 * the loader (rule #1); this route never touches the DB. Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const candidates = await loadSavedVillageCandidates();
  const body: MobileSavedResponse = { candidates };
  return NextResponse.json(body);
}
