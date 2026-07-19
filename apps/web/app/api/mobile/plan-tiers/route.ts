import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { buildPlanCatalog, type PlanCatalogView } from '~/lib/plan/catalog';
import { isStripeCheckoutConfigured } from '~/lib/webhooks/stripe-billing';
import type { MobilePlanTiersResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/plan-tiers — the native Plan surface: the family's CURRENT tier
 * (families.planTier, via loadFamilyBasics) plus the plan CATALOG derived from the
 * @hale/types source of truth (PLAN_DISPLAY). Serving it here keeps the app from
 * hardcoding tier names/prices/features — the native bundle can't import package
 * code, so the catalog travels over the API. This route never touches the DB
 * itself; the loader owns it. Auth() is the 401 gate.
 *
 * Distinct from GET /api/mobile/plan (the WEEK plan). Checkout is WEB-ONLY (Apple IAP
 * policy) — this stays informational; `billingConfigured` only softens the copy.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const basics = await loadFamilyBasics();
  const catalog: PlanCatalogView = buildPlanCatalog(
    basics.planTier,
    isStripeCheckoutConfigured(),
  );

  const body: MobilePlanTiersResponse = { catalog };
  return NextResponse.json(body);
}
