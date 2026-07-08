import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { requireCronSecret } from '~/lib/cron/auth';
import { runPushRemindersCron } from '~/lib/cron/push-reminders';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the reminder reads the family's children + done markers from
// Postgres and sends via Expo's HTTP API — neither works on the edge runtime.
export const runtime = 'nodejs';
// Each family is a couple of bounded reads + at most one push; allow the full
// Fluid Compute window so a batch of families completes in one invocation.
export const maxDuration = 300;

/**
 * GET /api/cron/push-reminders — the daily health-reminder run, triggered by
 * Vercel Cron.
 *
 * Cron auth is the gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the engine does NOTHING — no
 * DB read, no send. Only a legitimate cron call reminds. Each family gets at most
 * one health push per day (the push_sends debounce); teen redaction is age-based
 * (rule #1) and every send is audited (rule #6).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runPushRemindersCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/push-reminders failed');
    throw err;
  } finally {
    // Serverless flush: send buffered spans before the function returns (rule #8).
    await flushTelemetry();
  }
}
