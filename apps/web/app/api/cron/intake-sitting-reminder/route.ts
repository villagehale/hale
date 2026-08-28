import { NextResponse } from 'next/server';
import { runSittingReminderCron } from '~/lib/channel/intake/sitting-reminder';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';

// Node runtime: the sweep reaches the session store and the Twilio send, neither of
// which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/intake-sitting-reminder — VIL-324.
 *
 * Hourly Vercel Cron. Sends at most once, only in the 8:00 America/Toronto hour,
 * only to open awaiting_details intakes that sat past first-hello. Sitting
 * sessions stay intakes — this route does not provision a family.
 *
 * Cron-secret gated: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and NOTHING runs.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const summary = await runSittingReminderCron(db());
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
