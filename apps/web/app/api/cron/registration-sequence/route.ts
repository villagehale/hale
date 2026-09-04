import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runRegistrationSequenceCron } from '~/lib/registration/sequence/run';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reaches the approval spine (which runs the reviewer) and the
// channel seam, neither of which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/registration-sequence — the M7 registration ladder (VIL-242),
 * triggered EVERY FIVE MINUTES by Vercel Cron.
 *
 * Five minutes, not the hourly cadence every other sweep uses, and the go leg is the
 * whole reason: it lives in the fifteen minutes before a municipal registration opens
 * and may never be sent after it (a "here's your link, it opens at 6:30" at 6:31 is a
 * lie). An hourly cron would hit that interval one time in four, so the single most
 * valuable message this product sends would usually not arrive. Every other leg has an
 * interval hours or days wide, and the extra ticks cost one narrow indexed read of a
 * table with one row per family per registration window.
 *
 * Its own route rather than a leg of /api/cron/nudge for the same reason the nudge got
 * one: different cadence, different failure budget, and different logs for what are
 * genuinely different risks.
 *
 * Two gates, both fail-closed. Cron auth is the spend gate: a request without
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and NOTHING runs. F14_ENABLED /
 * F14_FAMILY_ALLOWLIST is the D21 dark-launch gate: unarmed, the sweep does not even
 * select a family.
 */
export const GET = cronRoute('registration-sequence', async () => {
  try {
    const summary = await runRegistrationSequenceCron(db());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
});
