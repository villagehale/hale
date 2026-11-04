import { NextResponse, after } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { connectorSyncDeps, runConnectorSync } from '~/lib/cron/connector-sync';
import { runConnectorSweepLegs } from '~/lib/cron/connector-sync-legs';
import { kickDrain } from '~/lib/cron/kick-drain';
import { db } from '~/lib/db';
import {
  expireStaleGoogleRevocations,
  retryPendingGoogleRevocations,
} from '~/lib/integrations/google-disconnect';
import { renewDueGooglePushWatches } from '~/lib/integrations/google-push-runtime';
import { getQueue } from '~/lib/queue';

// Node runtime: reads/writes integrations via the postgres driver and enqueues on
// pg-boss (raw pg) — neither works on the edge runtime. The sweep fans out one
// bounded Google poll per active connection.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/connector-sync — the poll sweep for Calendar/Gmail/Drive
 * connectors. Read-only: each changed item is redacted (rule #1) and enqueued as
 * events.ingested, then HELD for approval downstream (rule #4 — no autonomous
 * action). Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the sweep does NOTHING (no DB
 * read, no Google call).
 */
export const GET = cronRoute('connector-sync', async (req: Request) => {
  const database = db();
  // The revoke legs first, each leg isolated and named (connector-sync-legs.ts): a
  // pending revoke holds a live token, and the sweep behind it must not starve it.
  const legs = await runConnectorSweepLegs({
    googleRevokeExpiry: () => expireStaleGoogleRevocations(database, new Date()),
    googleRevokeRetry: () => retryPendingGoogleRevocations(database),
    sync: async () => runConnectorSync(connectorSyncDeps(database, await getQueue())),
    // The poll above is the fallback. This renews push channels when the flag is on
    // and names flag_off when it is not — it never replaces the sweep.
    pushRenewal: () => renewDueGooglePushWatches(database),
  });

  // Kick the drain so freshly-enqueued events flow through the pipeline now rather
  // than waiting up to 60s for the next cron tick (the cron is the safety net).
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  after(() => kickDrain(origin));

  return NextResponse.json(legs, { status: legs.ok ? 200 : 500 });
});
