import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { defaultTwilioTriageDeps, runTwilioTriage } from '~/lib/monitoring/twilio-triage';

// Node runtime: reads rate_limits/channel_messages via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/twilio-triage — the every-ten-minutes read of Twilio's Monitor
 * Alerts log (VIL-331). New webhook-failure alerts become one classified founder
 * diagnosis SMS per 30-minute window; the full triage (class, layer, evidence,
 * cursor state) comes back in the JSON for the cron log.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const result = await runTwilioTriage(db(), defaultTwilioTriageDeps(), new Date());
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
}
