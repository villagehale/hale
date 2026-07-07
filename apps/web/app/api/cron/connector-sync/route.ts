import { NextResponse, after } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { connectorSyncDeps, runConnectorSync } from '~/lib/cron/connector-sync';
import { kickDrain } from '~/lib/cron/kick-drain';
import { db } from '~/lib/db';
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
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const queue = await getQueue();
  const summary = await runConnectorSync(connectorSyncDeps(db(), queue));

  // Kick the drain so freshly-enqueued events flow through the pipeline now rather
  // than waiting up to 60s for the next cron tick (the cron is the safety net).
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  after(() => kickDrain(origin));

  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
