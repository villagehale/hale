import { NextResponse, after } from 'next/server';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { cronRoute } from '~/lib/cron/auth';
import { drainOrigin, kickDrain } from '~/lib/cron/kick-drain';
import { db } from '~/lib/db';
import { runReminderCron } from '~/lib/loop/reminders/run';
import { isPreviewDeploy } from '~/lib/preview/family-scope';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the send path reaches pg-boss + the channel seam, neither of which
// runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/reminders — the D1 reminder scheduler (VIL-223), triggered HOURLY by
 * Vercel Cron. Each hour it converges the event_reminders ledger from live placed
 * events, then fires the due reminders that survive a fresh classify against the live
 * event (a cancelled/moved/started event never fires). Firing reminders enqueue onto
 * the A2 channel.send queue, which dispatches them (mirror legs, dedupe, ledger, audit).
 *
 * Cron auth is the spend gate: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and NOTHING runs. The SEND itself is additionally gated by LOOP_SEND_ENABLED
 * (default off) — compose-not-send until the founder flips it.
 */
export const GET = cronRoute('reminders', async (req: Request) => {
  try {
    const summary = await runReminderCron(db());
    // On Preview the sends went into Preview's own pg-boss schema, which no
    // production drain can claim and no scheduled drain reaches, so Preview drains
    // them itself right away. Production keeps the every-minute drain.
    if (isPreviewDeploy()) {
      const origin = drainOrigin(req);
      after(() => kickDrain(origin, [CHANNEL_SEND_QUEUE]));
    }
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
});
