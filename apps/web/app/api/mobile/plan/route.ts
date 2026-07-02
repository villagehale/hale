import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadCompanion } from '~/lib/companion/queries';
import { planChildItems } from '~/lib/plan/week';
import { loadVillage } from '~/lib/village/queries';
import type { MobilePlanResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/plan — the native Plan ("your week") tab. Returns the SAME
 * server-side projection the web plan page computes: the accepted, non-teen
 * activities added to the week, the latest routine, and the forward-looking
 * per-child items (planChildItems). Teen-attributed candidates are filtered here
 * exactly as the page does; loadVillage already redacts their raw fields (rule #1).
 * Auth() is the 401 gate.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const [village, children] = await Promise.all([loadVillage(), loadCompanion()]);
  const addedActivities = village.candidates.filter((c) => c.accepted && !c.teenAttributed);
  const childItems = planChildItems(children);
  const hasRoutine = (village.routine?.items.length ?? 0) > 0;
  const hasPlan = hasRoutine || childItems.length > 0 || addedActivities.length > 0;

  const body: MobilePlanResponse = {
    addedActivities,
    routine: village.routine,
    childItems,
    hasPlan,
  };
  return NextResponse.json(body);
}
