import { NextResponse } from 'next/server';
import { enqueueChannelMessageReceived } from '~/lib/channel/twilio/deps';
import { reconcileUnhandedInbound } from '~/lib/channel/twilio/reconcile';
import { cronRoute } from '~/lib/cron/auth';
import { runQueueMaintenanceCron } from '~/lib/cron/queue-maintenance';
import { db } from '~/lib/db';

// Node runtime: instantiates pg-boss (prepared statements, raw pg) — not edge.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/queue-maintenance — the queue's own upkeep, on a schedule, because the
 * supervising Fly worker is not deployed. Cron-secret gated like every cron route.
 *
 * Two jobs, both of the same kind: things the queue cannot do for itself.
 *   1. pg-boss maintenance — expire stuck `active` jobs, archive completed (recipe #2).
 *   2. The inbound hand-off reconciler — re-drive texts that were recorded but whose
 *      enqueue failed. Twilio's retry cannot do it (the claim index makes the retry a
 *      'duplicate'), so without this a queue blip loses a parent's message silently.
 *
 * Sequential, and maintenance goes first: if it throws, the run fails here and the
 * reconciler waits for the next tick ten minutes later. That is the right order —
 * whatever broke pg-boss maintenance is the thing to fix, and re-driving texts into a
 * queue that is itself unwell would only add failures to the pile.
 */
export const GET = cronRoute('queue-maintenance', async () => {
  try {
    await runQueueMaintenanceCron();
    const inbound = await reconcileUnhandedInbound({
      database: db(),
      enqueue: enqueueChannelMessageReceived,
      log: console,
    });
    return NextResponse.json({ ok: true, inbound }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log to the platform, then
    // re-throw so the run stays a real error, not a masked success (rule #8).
    console.error({ err }, 'cron/queue-maintenance failed');
    throw err;
  }
});
