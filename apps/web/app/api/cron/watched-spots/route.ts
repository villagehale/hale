import { NextResponse } from 'next/server';
import {
  defaultWatchedSpotsSweepDeps,
  runWatchedSpotsSweep,
} from '~/lib/channel/spots/sweep';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep opens a Postgres connection and fetches municipal pages.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/watched-spots — VIL-337's ten-minute re-read of the course pages
 * families asked Hale to watch. Triggered by Vercel Cron at minutes 1, 11, 21, 31, 41
 * and 51 (vercel.json), so median detection is about five minutes and the ack promises
 * "within about ten minutes of the page showing it", never "the moment".
 *
 * NO ANTHROPIC CLIENT, deliberately. Nothing on this path is a judgement call: a
 * PerfectMind course page carries its availability as typed integers and booleans in an
 * embedded JSON model, and the sentence that goes out is a template with an evidence
 * gate. A model here would only add a way to be wrong, and it would put a family's
 * course page in front of one (rule #1).
 *
 * Cron auth is the gate: without the matching `Authorization: Bearer <CRON_SECRET>` the
 * request gets 401 and nothing runs — no fetch, no send, no writes. `cronRoute` stamps
 * the dead-man ledger on completion, which is why every per-spot failure inside the
 * sweep is a counted outcome rather than a throw: one municipality being down must not
 * make this cron read stale and page the founder.
 */
export const GET = cronRoute('watched-spots', async () => {
  try {
    const summary = await runWatchedSpotsSweep(db(), defaultWatchedSpotsSweepDeps());
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log, then re-throw so the run
    // stays a real error rather than a masked success (rule #8).
    console.error({ err }, 'cron/watched-spots failed');
    throw err;
  } finally {
    await flushTelemetry();
  }
});
