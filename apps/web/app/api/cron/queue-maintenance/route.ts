import { NextResponse } from 'next/server';
import { sweepUnconfirmedClaims } from '~/lib/channel/claim-sweep';
import { enqueueChannelMessageReceived } from '~/lib/channel/inbound-deps';
import { reconcileUnhandedInbound } from '~/lib/channel/reconcile/unhanded';
import { cronRoute } from '~/lib/cron/auth';
import { runQueueMaintenanceCron } from '~/lib/cron/queue-maintenance';
import { db } from '~/lib/db';
import {
  checkDeliveryHealth,
  claimDeliveryIncident,
  loadDeliveryStats,
} from '~/lib/monitoring/delivery-health';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

// Node runtime: instantiates pg-boss (prepared statements, raw pg) — not edge.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/queue-maintenance — the queue's own upkeep, on a Vercel Cron
 * schedule (yul1). Cron-secret gated like every cron route.
 *
 * Four jobs, all of the same kind: things a single request cannot finish for itself.
 *   1. pg-boss maintenance — expire stuck `active` jobs, archive completed (recipe #2).
 *   2. The inbound hand-off reconciler — re-drive texts that were recorded but whose
 *      enqueue failed. A provider retry cannot do it (the claim index makes the retry a
 *      'duplicate'), so without this a queue blip loses a parent's message silently.
 *   3. The executor claim sweep — a send claimed and never confirmed becomes a named
 *      outcome (claim-sweep.ts).
 *   4. Delivery health — Linq receipts already wrote the ledger; this pages Slack #ops
 *      when the trailing window's failure rate, or a registration-class code, is an
 *      incident (delivery-health.ts).
 *
 * Sequential, and maintenance goes first: if it throws, the run fails here and the
 * reconciler waits for the next tick ten minutes later. That is the right order —
 * whatever broke pg-boss maintenance is the thing to fix, and re-driving texts into a
 * queue that is itself unwell would only add failures to the pile.
 */
export const GET = cronRoute('queue-maintenance', async () => {
  try {
    await runQueueMaintenanceCron();
    const database = db();
    const inbound = await reconcileUnhandedInbound({
      database,
      enqueue: enqueueChannelMessageReceived,
      log: console,
    });
    const claims = await sweepUnconfirmedClaims({ database, log: console });
    const health = await checkDeliveryHealth(
      database,
      {
        loadStats: loadDeliveryStats,
        claim: claimDeliveryIncident,
        sendAlert: (body) => postOpsSlack(body, fetch),
      },
      new Date(),
    );
    return NextResponse.json({ ok: true, inbound, claims, health }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/queue-maintenance failed');
    throw err;
  }
});
