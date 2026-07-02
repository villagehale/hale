import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import type { MobileFamilyResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/family — the native Family tab: the household's parents (primary
 * + co-parent) and its editable basics (children, coarse location, plan tier),
 * mirroring the web family page. Both loaders own the DB; this route never touches
 * it (rule #1). Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [members, basics] = await Promise.all([loadFamilyMembers(), loadFamilyBasics()]);

  const body: MobileFamilyResponse = { members, basics };
  return NextResponse.json(body);
}
