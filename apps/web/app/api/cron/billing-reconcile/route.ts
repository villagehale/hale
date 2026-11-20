import { NextResponse } from 'next/server';
import { reconcileBillingTiers } from '~/lib/billing/billing-live';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/**
 * GET /api/cron/billing-reconcile — page #ops when a paid parent is on Free
 * limits, or a refund did not drop the tier. Dark unless
 * STRIPE_BILLING_REVOKE_ENABLED is exactly `true`. Slack only; never a parent
 * text. Counts only, no family id.
 */
export const GET = cronRoute('billing-reconcile', async () => {
  const result = await reconcileBillingTiers(db());
  if (result.status === 'flag_off') {
    return NextResponse.json({ ok: true, skipped: 'flag_off' }, { status: 200 });
  }
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});
