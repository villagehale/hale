import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadVillage } from '~/lib/village/queries';
import type { MobileVillageResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/village — the native Village tab: this family's discovered
 * candidates + latest routine, teen-safe (a 13+ child's candidate/routine item is
 * redacted at the mapper inside loadVillage). This route never touches the DB
 * (rule #1). Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body: MobileVillageResponse = await loadVillage();
  return NextResponse.json(body);
}
