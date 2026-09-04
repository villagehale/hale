import { NextResponse } from 'next/server';
import { credentials } from '~/lib/admin/services/twilio';
import {
  fetchTwilioMessageState,
  runDeliverySweep,
} from '~/lib/channel/twilio/delivery-sweep';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import {
  checkDeliveryHealth,
  claimDeliveryIncident,
  loadDeliveryStats,
} from '~/lib/monitoring/delivery-health';
import { sendFounderOpsSms } from '~/lib/monitoring/twilio-triage';

// Node runtime: reads channel_messages via the postgres driver (not edge).
export const runtime = 'nodejs';
// The sweep is up to DELIVERY_SWEEP_BATCH_LIMIT provider GETs, each bounded at
// SERVICE_TIMEOUT_MS — sized so a tick where every request times out still finishes.
export const maxDuration = 300;

/**
 * GET /api/cron/delivery-sweep — the outbound delivery-truth loop, every ten
 * minutes: re-fetch provider truth for stale pre-terminal rows (or force a named
 * terminal when nothing can confirm the send), then judge the trailing window's
 * delivery health and page the founder on an incident. Sweep first, on purpose:
 * the health check must see the statuses this tick just recovered.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export const GET = cronRoute('delivery-sweep', async () => {
  if (!credentials()) {
    // Twilio dark = nothing to poll AND nothing was sent that could fail. Named,
    // logged, not an error: the leg is unprovisioned, not broken (rule #11).
    console.error('delivery sweep: twilio not configured — nobody is reconciling delivery truth');
    return NextResponse.json({ ok: true, outcome: 'skipped_not_configured' }, { status: 200 });
  }

  try {
    const database = db();
    const sweep = await runDeliverySweep({
      database,
      fetchMessageState: (sid) => fetchTwilioMessageState(fetch, sid),
      log: console,
    });
    const health = await checkDeliveryHealth(
      database,
      {
        loadStats: loadDeliveryStats,
        claim: claimDeliveryIncident,
        sendSms: (body) => sendFounderOpsSms(body, fetch),
      },
      new Date(),
    );
    return NextResponse.json({ ok: true, sweep, health }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/delivery-sweep failed');
    throw err;
  }
});
