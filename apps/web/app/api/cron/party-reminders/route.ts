import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runPartyReminderCron } from '~/lib/party/reminders';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep decrypts a stored number (node:crypto) and reaches the SMS
// transport, neither of which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/party-reminders — VIL-245 · M10's day-before reminder to guests who
 * asked for one, triggered HOURLY by Vercel Cron.
 *
 * Hourly rather than M7's five-minute cadence because nothing here is minute-critical:
 * the leg fires in the host family's 10 a.m. hour and a reminder that lands at 10:50
 * instead of 10:05 is the same reminder. Its own route rather than a leg of another
 * sweep because it is the only send path in Hale addressed to NON-USERS, and a failure
 * budget for that should not be shared with a message to a customer.
 *
 * Two gates, both fail-closed. Cron auth is the spend gate: no `Authorization: Bearer
 * <CRON_SECRET>` → 401 and nothing runs. F14_ENABLED / F14_FAMILY_ALLOWLIST is the D21
 * dark-launch gate, applied per family inside the sweep.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  try {
    const summary = await runPartyReminderCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
}
