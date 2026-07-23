import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runLoopHealthDigestCron } from '~/lib/loop/health-digest';

// Node runtime: Resend + the postgres driver aren't edge-compatible.
export const runtime = 'nodejs';

/**
 * GET /api/cron/loop-health-digest — X1 (VIL-227) weekly founder digest: sends,
 * failures/suppressions, STOPs, and week_plans composed over the trailing 7 days,
 * emailed to the founder (aloha@ → FOUNDER_ALERT_EMAIL/WELCOME_BCC). Un-gated by a
 * send flag (unlike the parent-facing digest/loop sends) — it degrades to a clean
 * no-op via its own sender guards when no founder address/Resend key is set.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const result = await runLoopHealthDigestCron(db());
  return NextResponse.json({ ok: true, sent: result.sent }, { status: 200 });
}
