import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadCompanion } from '~/lib/companion/queries';
import { loadFamilyMembers } from '~/lib/dashboard/queries';
import { loadVillage } from '~/lib/village/queries';
import type { MobileHomeResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/home — the native Home/Today tab. Composes the same loaders the
 * web home page uses (per-child companion views, the village feed, the family
 * members) minus the web-shell-only pieces (coach seed, activation checklist,
 * streamed feed suspense). Teen redaction lives inside the loaders; this route
 * never touches the DB (rule #1). Auth() is the 401 gate — the loaders re-resolve
 * the family from the same session, so an unauthenticated caller gets 401, never
 * an empty payload.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [children, village, members] = await Promise.all([
    loadCompanion(),
    loadVillage(),
    loadFamilyMembers(),
  ]);

  const body: MobileHomeResponse = { children, village, members };
  return NextResponse.json(body);
}
